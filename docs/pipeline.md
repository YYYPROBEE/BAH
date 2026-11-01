# 工具管线（七段）与接缝挂点手册

> 规格依据：施工单 03 §2.2（顺序冻结）、§2.3（判决语义）、§2.5（呈现契约）、施工单 04 §5（接缝清单）。
> **顺序改动 = 破坏性变更**：必须同步更新本文件与架构文档，并跑全量快照（AGENTS.md 第 3 条）。

## 1. 七段的顺序与分工

| # | 段 | 实现 | 落账 | 谁能挂 |
|---|---|---|---|---|
| ① | `tool/call`（执行前） | `pipeline.ts` | `tool/call` | — |
| ② | `presentCall(args)` | 工具定义（纯函数） | — | 工具体作者 |
| ②e | **入参契约校验**（`argsSchema`） | `pipeline.ts` + `contracts.ts` | — | runtime 端口；宿主注入（W03） |
| ③ | `tools/pre-execute`（waterfall） | **判决平面**：危险规则 → PII → 预算 → 断路器 → 三级权限 | — | 施工单 09/10（**唯一阻断点**） |
| ③e | ask → 签票据 → `approval/request` | `pipeline.ts` | `approval/asked` / `approval/decided` | 施工单 09 + 渠道（13/14/15） |
| ④ | 单调 guard | `guard.ts` | — | 内核（插件无权绕过） |
| ⑤ | `tools/execute`（waterfall 环绕） | 工具体 | — | 施工单 11（沙箱/超时）、05（重试/指标） |
| ⑤e | **出参契约校验**（`resultSchema`） | `pipeline.ts` + `contracts.ts` | — | 同上（W03） |
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

## 8. 契约校验的两个插点（W03 G-1）

工具契约（`argsSchema` / `resultSchema`）由**宿主注入**：runtime 只定义
`TOOL_CONTRACTS` 端口（`packages/runtime/src/tools/contracts.ts`），
`bank:tools` 在 `packages/host/src/boot/plugins/bank-tools.ts` 里用
`specOf(name).schema` + `BANK_RESULT_SCHEMAS[name]` 提供实现。runtime 全程不认识 bank（R-1 未破）。

| 插点 | 精确位置 | 失败码 | 失败后的行为 |
|---|---|---|---|
| **②e 入参** | ①`tool/call` 落账之后、②`presentCall` 之后、③`pre-execute` **之前** | `tool-args-invalid` | 直接返回 `isError` 结果：**不签票据、不进审批、不跑工具体**；`tool/call` 仍在（审计要留下"模型发了什么"） |
| **⑤e 出参** | ⑤`tools/execute` 返回之后、⑥`projectContent` **之前** | `tool-result-invalid` | 置 `isError = true`，落账的 `tool/result` 自然带错；不进入 `post-execute` 的"成功"分支 |

**两个位置的理由**（顺序错了就是安全缺陷，不是风格问题）：

- ②e 若放在 ① 之前 → 审计里没有非法参数的 `tool/call`（TC-W03-09 红）；
- ②e 若放在 ③ 之后 → 票据可能已签发，等于"批了才发现参数错"（TC-W03-01 红）；
- ⑤e 若缺失 → 模型会拿着**不合格的出参**继续决策，而审计里只有一条成功的 `tool/result`
  ——这是全仓最危险的"假成功"形状（TC-W03-04）。

**错误码边界**：这两个码**不进** `guard`、**不计入** deny 统计，也不参与"越权拦截率"。
`reject()` 的语义是"治理面判 deny"；契约不合法是"模型发错了参数"，混进去会让赛题指标失真。
`invalid()` 与 `reject()` 因此是两条路径（`pipeline.ts` 的 `invalid()` 单独实现）。

**不泄露值本体**：失败文案由 `describeViolation()` 只拼 `path + detail`
（例如 `（/amount）契约校验失败：必须大于 0`），**不回显参数值**——文案会进模型上下文与审计，
回显金额/账号等于把 PII 写进日志（宪法 §4）。

**缺省不校验**：`TOOL_CONTRACTS` 未提供时 `findToolContracts()` 返回 `undefined`，管线跳过校验。
这是为纯内核 profile 保留的向后兼容；反过来说，**任何会跑银行工具的 profile 必须显式提供本服务**，
否则等于校验没通电（宿主侧有"boot 后可取到契约"的通电用例守着）。

**校验器范围**：`packages/util/src/tool-contract-validate.ts` 是零依赖纯函数，**不抛错**，
只返回第一个 `ToolContractViolation`。支持 `type` / `required` / `enum` / `minimum` / `maximum` /
`exclusiveMinimum` / `exclusiveMaximum` / `minLength` / `maxLength` / `pattern` / `multipleOf` /
`properties` / `items` / `additionalProperties: false`。`amount` 的"必须 > 0、最多两位小数"
就是靠 `exclusiveMinimum: 0` + `multipleOf: 0.01` 表达（TC-W03-02）。

**`oneOf`（R-8）**：只做**根级一层 object 分支**（`risk_assess` 的 questions / submit 出参）。
**恰好命中 1 个分支**才算通过：0 个报 `oneOf`（文案列出每个分支的首个错误路径，只拼
`path + code`，不回显值本体），≥2 个报 `oneOf-ambiguous`；分支不是 object 报
`oneOf-non-object`，分支内嵌套 `oneOf` 报 `oneOf-nested`——不支持就明确失败，不静默放过。
**不做** `anyOf` / `allOf` / `not` / 递归求值；`additionalProperties` 仍不参与出参校验（既有口径）。

## 9. 铁律

1. 七段顺序不可重排（改 = 破坏性变更）；
2. presenter（`presentCall` / `presentResult` / `projectContent` / `finalizeContent`）是**纯函数**：
   不给 ctx、不读写外部状态、同输入同输出；
3. 工具**不硬编码阈值**：金额分档、超时、重试次数都走 Config（AGENTS.md 编码纪律第 4 条）；
4. 一切贡献可逆：`registry.register()` 返回 disposer，插件应当 `ctx.effect(disposer)` 挂到自己的生命周期上。
