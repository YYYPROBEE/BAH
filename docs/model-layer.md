# 模型层与提示词装配（施工单 05 落地说明）

> 读者：接主循环（阶段 5）、接 provider、写提示词段（插件线）的人。
> 规格权威仍是 `BAH-施工文档集/05-模型层与提示词装配.md`；本文只讲**本仓怎么落地**与**容易写错的点**。

## 1. 一张图

```text
            ┌──────────────── 提示词装配（runtime/system-prompt）────────────────┐
            │ 六段 0/10/20/30/40/50   capability 裁剪   render=undefined 即不装配   │
            │   ├─ header  → system/message（每次 attempt 一条，投影只认最新）      │
            │   └─ context → user/message(source=runtime-context) + request/context│
            └──────────────────────────────────────────────────────────────────────┘
                                   │
   会话日志（append-only） ── derive ─┤
                                   ▼
   buildModelHistory(events) → DerivedMessage[]（system → 摘要 → 原文）
                                   │
            ┌──────────────────────┴───────────────────────┐
            │  Adapter seam（@bah/llm，服务键 llm:adapters） │
            │  resolveModel → 能力位 → 装配裁剪              │
            │  prepareCall（冻结） → stream（StreamChunk）   │
            └──────────────────────┬───────────────────────┘
                                   ▼
                    StreamAssembler：分片 → 内容块 + 工具调用
                                   │
                    repairToolCall：校验 → 回灌 → 重试一次
```

## 2. 词汇表与块索引

`@bah/llm` 的 `ContentBlock`（`kind` 标签）是**模型消息**内容块；`@bah/core` 的 `ContentBlock`（`type` 标签）是**工具结果**内容块。同名不同域，跨包一律走包名，不会混。

块索引约定（`StreamChunk.index`，装配器靠它分组）：

| 索引 | 内容 |
|---|---|
| `0` | 文本块 |
| `1` | 推理块（`reasoning`，**不回灌** wire） |
| `2 + n` | 第 n 个工具调用块 |

> DeepSeek 的 `tool_calls[].index` 直接映射到 `2 + index`（见 `deepseek/wire.ts`）。

## 3. 三级防线（应对"工具参数漂移"）

```text
① 增量拼接：tool-call-delta 只累积文本，block-end 时整体 parse（assemble.ts）
   parse 失败不抛错，标注 parseError + 保留原文
② 结构化回灌：validateArguments 给出「$.amount 应为 number（实际 string）」
③ 修复重试一次：repairToolCall → reissue(feedback)
   仍不合法 → { kind: 'failed', code: 'tool-args-invalid' } → 调用方落 isError 的 tool/result
```

铁律：

1. **绝不在分片阶段 parse**：半截 JSON 必然失败，提前 parse 等于把正常调用判成坏参数。
2. **绝不无限重试**：`repairToolCall` 只重试一次；第二次仍错说明工具描述有歧义，要暴露给用户与审计。
3. **绝不静默当空对象**：坏 JSON 时 `args` 缺省、`argsText` 留原文。

## 4. Adapter seam

```ts
const registry = new LlmAdapterRegistry()
const off = registry.register(adapter)              // 返回 disposer（幂等）
registry.register(other, { replace: true })         // 覆盖必须显式声明
registry.resolve('deepseek:deepseek-chat')          // provider:model，或裸 model 名按注册顺序找
ctx.provide(LLM_ADAPTERS, registry)                 // provideLlm(ctx) 是它的快捷方式
```

- 施工单原文写 `ctx.llm.registerAdapter`；`api.ts` 已冻结、`Context` 上没有 `llm`，故按 00 §9「按键寻址」用服务键 `llm:adapters` 落地（语义等价）。
- `resolveModel()` 是**能力位的唯一来源**：模型不支持 function calling，就必须裁掉工具段（否则模型照着编工具名）。
- `prepareCall()` 返回 `Object.freeze` 的 `PreparedCall`：请求到这里就冻结，后续 listener 不许改写。

## 5. 降级链与成本账本

```ts
const runner = new FallbackRunner({
  registry,
  chain: ['deepseek:deepseek-chat', 'deepseek:deepseek-reasoner'],
  sink: { attempt: (record) => session.append('assistant/attempt', record) },
})
const run = await runner.run(request, signal)   // 已含首个分片，能证明"真的出流了"
```

- 只在**还没吐出任何分片**时降级；半截流没法撤回，那种情况如实报错。
- 一次成功降级 = 两条留痕：`failed`（为什么失败）+ `retried`（改用了谁）。
- 取消**不重试**（`llm-aborted` / `AbortError` → `cancelled`）。
- 用量：`UsageLedger.record(turn, usage)` 累加、`finishTurn(turn)` 结账（二次调用返回 `undefined`，防重复落账），主循环把结果写成 `usage/summary` 事件进审计。

## 6. 六段装配与能力位裁剪

| 序 | section | 何时不装配 |
|---|---|---|
| 0 | `identity.safety` | 永不裁剪（身份与安全底线） |
| 10 | `bank.domain` | 永不裁剪 |
| 20 | `bank.capabilities` | 模型无 `toolCall` 能力，或本次没注册工具 |
| 30 | `runtime.context` | 运行时视图为空；且**永远不进 system 头** |
| 40 | `policy.approval` | 模型无 `toolCall` 能力，或全部工具都是绿级 |
| 50 | `style` | 永不裁剪（未给渠道时按 headless） |

装配 API：

```ts
const prompt = createDefaultPromptRegistry()      // 或 ctx.get(SYSTEM_PROMPT_SERVICE)
const composed = prompt.compose({
  capabilities, tools, runtime, channel,
})
// composed.header  → system/message
// composed.context → user/message(source=runtime-context)
// composed.parts   → 本次实际装配出的段（按 order 升序，便于审计）
```

改 `SECTION_ORDERS` 或增加 section = 模型行为整体漂移 → 按破坏性变更处理（同步文档 + 跑全量快照）。

## 7. 运行时上下文（reconcile 语义）

**为什么不能拼进 system 头**：system 头是模型的稳定设定；掺入每轮变化的余额/最近交易就变成伪静态文本。落成 user 消息则天然可撤回、可审计。

```text
beginAttempt()
  ├─ system/message           ← 本次装配结果（每次 attempt 一条）
  ├─ request/context          ← 每次都落，texts 为空表示"本次没有运行时上下文"
  └─ user/message(source=runtime-context)   ← 仅当确有文本

buildModelHistory()
  ├─ collapseEvents()          ← 压缩折叠（剔除已摘要的 turn）
  ├─ reconcileContextEvents()  ← 撤回上次及更早的 runtime-context；只保留最新 system
  └─ deriveMessages()          ← 投影 + 摘要插在 system 之后
```

两处分源，别合并：

- `source: 'runtime-context'` = 每次 attempt 重渲染的运行时上下文，**会被撤回**；
- `source: 'context'` = 工具后置阶段追加的一次性纠正文本（`addContext` / `block`），**必须留在历史里**。

`agent.inject(text)` 走 `RuntimeContextQueue`：只登记、不落账，下一次 attempt 一起落成 `user/message`（模型可见 + 可审计）。

## 8. 压缩

```ts
const thresholds = resolveCompactionConfig({ maxTurns: 18, keepRecentTurns: 4 })  // fail-loud
const { plan, event } = runCompaction(session, thresholds)   // plan.needed=false 时不落事件
```

- 触发：token 估算 ≥ `maxTokens` 或完整 turn 数 > `maxTurns`，且折叠后仍能留下 `keepRecentTurns` 个 turn。
- **判定时机**：主循环在**每次请求装配前**判一次、turn 收尾再兜一次（阶段 8）。两处都只折叠
  **已完整结束**的 turn——当前 turn 永不折叠，否则会拆散 `tool/call ↔ tool/result` 配对并丢掉本轮用户问题；
  因此重复判定幂等（已折叠的 turn 在 `collapseEvents` 阶段就被剔除）。
- 摘要**确定性生成**（结构化统计 + 金融字段），不调模型：可回放、零成本、可逐字比对。
- 摘要落账为 `compaction/summary`（带 `refs` 事件引用），**不改写历史**；折叠只发生在投影层。
- 金融特例：涉及金额/收款人/票据/结论的条目保留结构化字段 `{ amount, payee, ticketId, decision }`；绿色直通调用没有票据时**不伪造票号**（`ticketId` 缺省、`decision: 'not-required'`）。
- 幂等：已折叠的 turn 不会重复摘要。
- 长 turn（多 step）内不会折叠**当前** turn：安全性与可审计性优先（配对不拆、本轮问题不丢）。
  若单 turn 本身就超过窗口，应在插件线用"工具结果裁剪 / 预算 guard"处理，而不是折叠当前 turn。

## 9. 常见误用（都踩过）

| 误用 | 后果 | 正确做法 |
|---|---|---|
| 分片阶段 `JSON.parse` | 正常调用被判坏参数 | `block-end` 时整体 parse |
| 把 runtime.context 拼进 system 头 | 每轮重发伪静态文本、无法撤回 | 落 `user/message(source=runtime-context)` |
| 用 `source: 'context'` 落运行时上下文 | 撤回旧上下文时把工具纠正文本一起撤掉 | 两个来源分开 |
| 重名 adapter 静默覆盖 | "谁最后装的谁生效"变隐藏行为 | `register(adapter, { replace: true })` |
| 降级判断放在出流之后 | 半截流已经发给用户 | 只在首个分片前降级 |
| 压缩后改写日志 | 破坏 append-only | 只落摘要事件 + 投影折叠 |
