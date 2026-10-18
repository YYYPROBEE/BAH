# 工具管线（七段）与接缝挂点手册

> 规格依据：施工单 03 §2.2（顺序冻结）、§2.3（判决语义）、§2.5（呈现契约）、施工单 04 §5（接缝清单）。
> **顺序改动 = 破坏性变更**：必须同步更新本文件与架构文档，并跑全量快照（AGENTS.md 第 3 条）。

## 1. 七段的顺序与分工

| # | 段 | 实现 | 落账 | 谁能挂 |
|---|---|---|---|---|
| ① | `tool/call`（执行前） | `pipeline.ts` | `tool/call` | — |
| ② | `presentCall(args)` | 工具定义（纯函数） | — | 工具体作者 |
| ③ | `tools/pre-execute`（waterfall） | **判决平面**：危险规则 → PII → 预算 → 断路器 → 三级权限 | — | 施工单 09/10（**唯一阻断点**） |
| ③e | ask → 签票据 → `approval/request` | `pipeline.ts` | `approval/asked` / `approval/decided` | 施工单 09 + 渠道（13/14/15） |
| ④ | 单调 guard | `guard.ts` | — | 内核（插件无权绕过） |
| ⑤ | `tools/execute`（waterfall 环绕） | 工具体 | — | 施工单 11（沙箱/超时）、05（重试/指标） |
| ⑥ | `projectContent` → `tools/post-execute` | 工具定义 + 后置平面 | — | 施工单 10（脱敏/改写/纠正上下文） |
| ⑦ | 归一化 → `finalizeContent` → `tools/result`(emit) → `tool/result` → `additionalContexts` → `presentResult` | `pipeline.ts` | `tool/result`、`user/message` | 工具体作者（presenter） |

## 2. 四个 waterfall 的载荷形状（都是「信封进出」）

waterfall 的输入和输出是**同一个类型**：listener 返回改写了判决字段的信封即完成判决；
不调 `next()` 直接返回 = 短路（"我拥有这个判决"）；旁听者必须 `return next(input)`。

| 事件 | 信封字段 | 默认判决 |
|---|---|---|
| `tools/pre-execute` | `{ call, verdict }` | `verdict = { kind: 'allow' }` |
| `tools/execute` | 一个**执行函数** `(call) => Promise<unknown>` | 工具体本身 |
| `tools/post-execute` | `{ call, content, verdict }` | `verdict = { kind: 'accept' }` |
| `approval/request` | `{ ticket, callId, name, summary, challenge, decision }` | `decision = { decision: 'unavailable' }` |

## 3. 判决语义（pre-execute）

```ts
// 阻断（短路，后续监听器不执行）
ctx.events.on('tools/pre-execute', (input) =>
  isDangerous(input.call)
    ? { ...input, verdict: { kind: 'deny', reason: '命中危险规则：批量转账', code: 'dangerous-op' } }
    : input, // 弃权 = 原样放行
)

// 需要审批（黄/红级）：pipeline 会签票据并走 approval/request
ctx.events.on('tools/pre-execute', (input) =>
  input.call.tier.level === 'green'
    ? input
    : { ...input, verdict: { kind: 'ask', ticket: { fingerprint, amount, ttlMs }, challenge: 'face' } },
)
```

**判决顺序不可重排**：`pre-execute` 永远先于单调 guard；ask 在 guard 之前解决；
超时这类"环绕"关注点通过 `tools/execute` 包裹实现，**绝不写进工具体**。

## 4. 环绕写法（`tools/execute`，唯一需要理解"函数中间件"的地方）

`tools/execute` 的载荷是**执行函数本身**，listener 用 `next(wrapped)` 交还一个包过的函数：

```ts
// 超时（施工单 11 的沙箱/超时策略就用这个形态）
ctx.events.on('tools/execute', async (run, next) => {
  const wrapped = async (call) =>
    Promise.race([
      run(call),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`工具执行超时（${TIMEOUT_MS}ms）`)), TIMEOUT_MS),
      ),
    ])
  return next(wrapped)
})

// 重试（只重试可重试错误，且必须有上限）
ctx.events.on('tools/execute', async (run, next) =>
  next(async (call) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run(call)
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error
      }
    }
  }),
)

// 指标（观察耗时，不改变结果）
ctx.events.on('tools/execute', async (run, next) =>
  next(async (call) => {
    const startedAt = Date.now()
    try {
      return await run(call)
    } finally {
      metrics.observe(Date.now() - startedAt)
    }
  }),
)
```

层级：**先注册的在外层**（每个 listener 拿到的是"内层已经包好的执行函数"）。
环绕层抛的错同样被管线归一化为 `isError`（`code = 'tool-failed'`），不冒泡到主循环。

## 5. 结果后置（`tools/post-execute`）

```ts
// 脱敏（改写内容）
ctx.events.on('tools/post-execute', (input) =>
  next({ ...input, content: maskPii(input.content) }), // 记得交还
)

// 拦截（模型做错了事：block + 纠正上下文一起给）
ctx.events.on('tools/post-execute', (input) =>
  containsPii(input.content)
    ? { ...input, verdict: { kind: 'block', reason: '结果含 PII，已拦截', code: 'pii-blocked' } }
    : input,
)

// 追加纠正上下文（FIFO，落在 tool/result 之后）
ctx.events.on('tools/post-execute', (input) => ({
  ...input,
  verdict: { kind: 'addContext', texts: ['转账前请先确认收款人户名'] },
}))
```

## 6. 审批流（`approval/request`）

1. `pre-execute` 返回 `ask` → 管线签 `TicketRef`（五绑定里本单可见：指纹 / 金额 / 时效）；
2. 落账 `approval/asked` → 派发 `approval/request`（waterfall）；
3. 渠道应答者返回 `{ ...input, decision: { decision: 'allowed-once' } }` 即批准；
4. **无人应答**：`decision` 保持默认 `unavailable` → 管线判 deny（`code = 'approval-unavailable'`），
   并落账 `approval/decided`。**unavailable = 拒绝**是硬规则（施工单 00 §11）；
5. 票据**状态机**（核销）属主在 bank-core（施工单 07 §3），管线只做生命周期记账。

## 7. 失败与补记

- 工具体抛错 → 归一化为 `isError` 结果（`code = 'tool-failed'`），继续走落账与卡片；
- step 中途失败（模型取消/超时/异常）时，用 `ToolCallRecovery` 补齐已落账的 `tool/call`：

```ts
const recovery = new ToolCallRecovery()
const stop = ctx.events.on('session/event', ({ event }) => recovery.observe(event))
try {
  await step()
} catch (error) {
  for (const recovered of recovery.results()) session.append('tool/result', recovered.data)
  throw error
} finally {
  stop()
}
```

补记的 `code = 'tool-interrupted'`，与"执行失败"（`tool-failed`）在审计里可区分。

## 8. 铁律

1. 七段顺序不可重排（改 = 破坏性变更）；
2. presenter（`presentCall` / `presentResult` / `projectContent` / `finalizeContent`）是**纯函数**：
   不给 ctx、不读写外部状态、同输入同输出；
3. 工具**不硬编码阈值**：金额分档、超时、重试次数都走 Config（AGENTS.md 编码纪律第 4 条）；
4. 一切贡献可逆：`registry.register()` 返回 disposer，插件应当 `ctx.effect(disposer)` 挂到自己的生命周期上。
