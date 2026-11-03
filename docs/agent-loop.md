# 主循环 agent-loop

> 读者：接主循环的插件作者（挂四个接缝）、写渠道 / UI 的人（用 `Agent` 五能力）、做回放与审计的人。
> 本文只讲**本仓怎么落地**与**容易写错的点**。

## 1. 一张图

```text
turn/start（先开 turn：turn 号从日志续号，分叉/回放的会话不从 1 重来）
  │
  ├─ while (true)
  │    preStep：inbox.claim(车道) + agent/pre-step（waterfall：reject | enter）
  │      ├─ reject            → turn/end{blocked}（无 step，认领消息丢弃）
  │      ├─ 首个认领为空       → turn/end{completed}（无 step）
  │      └─ 粘性结束且认领为空  → 关闭
  │
  │    step/start
  │      ⓪ 解析首选模型（压缩水位按它的能力位算工具 schema 开销）
  │      ① 压缩判定（阈值触发，幂等：只折叠**已完整结束**的 turn；本 turn 永不折叠）
  │      ② 装配（纯）：提示词 × 模型能力位 + 日志派生历史 + 认领消息 + 注入上下文
  │      ③ agent/request（waterfall：改路由 / 参数）
  │      ④ prepareCall（冻结；失败/取消**都不提交** system/user）
  │      ⑤ 提交：request/header → system/message → request/context → user/message
  │      ⑥ llm/stream（waterfall 环绕）→ StreamAssembler
  │      ⑦ 工具七段管线（逐个：tool/call → tool/result）
  │      ⑧ assistant/message 收尾（带 toolCalls）
  │    step/end（工具失败时先补记 tool/result，再落 assistant/message）
  │
  │    sticky(结束原因)
  │      有结束原因且无转向消息 → agent/turn-stopping（serial）→ 关闭
  └
压缩判定（兜底）→ usage/summary → turn/end（reason 必落）
```

## 2. 一个 step 的落账时序（记不住就照抄）

| 顺序 | 事件 | 为什么在这个位置 |
|---|---|---|
| 1 | `request/header` | 冻结后的路由/参数快照；**在提交点**才写，之前取消的不留痕 |
| 2 | `system/message` | 本次装配结果（旧的那条由 reconcile 撤回） |
| 3 | `request/context` | **每次都落**（`texts: []` 也落）：它是"撤回过期上下文"的边界 |
| 4 | `user/message`(`runtime-context`) | 仅当确有运行时上下文 |
| 5 | `user/message`(认领消息) | 用户原话 / 转向指令 |
| 6 | `tool/call` → `tool/result` | 七段管线（执行前落 call、冻结结果落 result） |
| 7 | `assistant/message` | **带 toolCalls**：工具跑完后收尾落账（工具跑完后收尾落账的顺序） |
| 8 | `step/end` | finally 落账（失败也落） |

> 日志顺序 ≠ wire 顺序：wire（OpenAI 兼容）要求「带 tool_calls 的 assistant 消息」排在 `tool` 消息之前。
> 这一顺序由 `deriveMessages()` 的两遍投影恢复（先索引每条 assistant 消息承载的 `callId`，
> 在首个 `tool/result` 处把消息顶到前面）；工具执行抛错时也照常落 assistant 消息，
> 否则 `tool/result` 找不到承载它的消息（`session-log-hole`）。assistant 消息按 wire 合法性提前落账。
>
> 压缩判定放在**每次请求装配前**（§5 的"阈值触发"），turn 收尾再兜一次：
> turn 收尾那一刻本 turn 还没落 `turn/end`，折不到它；请求前这次能覆盖"进程恢复 / 上一次 turn
> 没收尾"等场景。两处都只折叠**已完整结束**的 turn——当前 turn 永不折叠（否则会拆散
> `tool/call ↔ tool/result` 配对），因此重复调用是幂等的。

## 3. 四个接缝（本设计只加这四个）

| 接缝 | 模式 | 载荷 | 用途 |
|---|---|---|---|
| `agent/pre-step` | waterfall | `{ agent, messages, turn, step, signal, verdict }` | 归一化 / 注入检测 / 审计改写；`verdict.kind='reject'` 即入口拒绝 |
| `agent/request` | waterfall | `{ agent, turn, step, request }` | 模型路由、降级、成本控制；`prepareCall` 之后不再派发 |
| `llm/stream` | waterfall | `(call, signal) => AsyncIterable<StreamChunk>` | 观测 / 重试 / 限流（环绕生产者，不写进 adapter） |
| `agent/turn-stopping` | serial | `{ agent, turn, signal, stop(reason?) }` | 收尾、写审计、循环 guard 判停；`stop()` → `turn/end.reason = { kind: 'guard-stopped', reason }` |

写法（都是"同一信封进出"，旁听者必须 `return next(input)`）：

```ts
// 入口平面：只观察，不阻断
ctx.events.on('agent/pre-step', (input, next) => {
  audit.entry(input.turn, input.messages)
  return next(input)
})

// 拒绝（入口拒绝 = 这个 turn 直接 blocked，没有 step）
ctx.events.on('agent/pre-step', (input, next) =>
  next({ ...input, verdict: { kind: 'reject', code: 'entry-blocked', reason: '无身份' } }),
)

// 路由：改模型（冻结点之后改不动了）
ctx.events.on('agent/request', (input, next) =>
  next({ ...input, request: { ...input.request, modelId: 'deepseek:deepseek-chat' } }),
)

// 观测流式（环绕）
ctx.events.on('llm/stream', (stream, next) =>
  next(async function* (call, signal) {
    const startedAt = Date.now()
    for await (const chunk of stream(call, signal)) yield chunk
    metrics.latency('llm', Date.now() - startedAt)
  }),
)

// 收尾：想继续 → 往 next-step 推一条提示；想停 → stop(reason)
ctx.events.on('agent/turn-stopping', (input) => {
  if (input.turn > 0 && noReadResultThisTurn()) input.stop('循环 guard：无工具结果不得陈述账户事实')
})
```

## 4. Inbox：两条车道 + 唤醒

| 车道 | 谁进 | 谁认领 |
|---|---|---|
| `next-turn` | `agent.send(text)` | 新 turn 的**第一个** step |
| `next-step` | `agent.steer(text)` | 当前 turn 的**后续** step（当前 step 完成后立刻认领，不新开 turn） |

- `claim()` **取走即离队**：入口 reject 之后消息不会复活（"拒绝"就是没发生）。
- 空白文本不入队；关闭后 `send` 抛 `inbox-closed`。
- `drive()` 空队列时挂在 `waitForInput()` 上，任何入队 / 关闭都会 `wakeDriver()` 把它叫醒；
  `run()` 是"跑到队列空"的一次性驱动（**至少一个 turn**：T-LOOP-011 的"首个认领为空"走它）。

## 5. 中断与取消边界（最容易写反）

```text
interrupt() ──► 当前 turn 的 AbortController 取消
                 │
                 ├─ 在 agent/request 里取消   → 什么都不提交（连 system 都没有）
                 ├─ 在 prepareCall 里取消     → 同上
                 ├─ 在流式阶段取消            → 已提交 system/user，但不落 assistant/message
                 └─ 流正常但信号已取消        → 同上（半截回复不落账）
```

两个不变量：

1. **每 turn 一个 controller**，新 turn 换新的（旧 latch 失效）；`TurnAbort.generation` 可观察；
2. 取消**不换模型重试**（那是 `@bah/llm` 的 `FallbackRunner` 规则，主循环不越权）。

取消都落 `assistant/attempt{status:'cancelled'}`，`turn/end.reason.kind='aborted'`。

工具批次中途取消：正在执行的调用不打断（写操作保原子性），同批**尚未开始**的调用
逐条补 `tool/result{isError:true, code:'tool-interrupted'}`，不留 `tool/call` 空洞。

## 6. 失败补记（`tool/call` 不许留空洞）

```text
step 中途抛错
  ├─ ToolCallRecovery 已通过 session/event 观察到「已开始、未完成」的调用
  ├─ catch：逐条 append tool/result{isError:true, code:'tool-interrupted'}
  ├─ finally：append assistant/message（承载 toolCalls；否则 tool/result 无主）
  ├─ finally：append step/end
  └─ 原样抛出（收尾段兜底先落 turn/end{failed}，再把异常抛给调用方）
```

`deriveMessages()` 把"有 `tool/call` 没 `tool/result`"当错误（`session-log-hole`），
也把"`tool/result` 找不到承载它的 `assistant/message`"当错误（同样拒绝静默合成）——
所以补记与"失败也落 assistant/message"都不是可选项，是让日志能被重建的前提。

## 7. 回退分叉

```text
源会话（只读）── seedUpTo(events, turn N) ──► 连续前缀（到 turn N 的 turn/end 为止）
                                             │
                              新 SessionStore.restore(seed)（校验 seq 连续）
                                             │
                        新 Context + provideSession → 新 runtime:session
                                             │
                      AgentLoop.fork → forkInfo{ parentSession, seedLength, turn }
```

- 原会话**一个字节不动**；分叉出来的 agent 续 turn 号（从种子日志里最后一个 `turn/start` 续）。
- 边界 turn 没结束（没有 `turn/end`）→ `fork-turn-missing`（fail-loud）。
- 为什么新会话要新 `Context`：`runtime:session` 是服务键，一个应用承载一个会话（装配方式见 architecture.md）。

## 8. 常用误用（都会出事）

| 写法 | 后果 | 正确做法 |
|---|---|---|
| 在 `agent/pre-step` 里 `await next(...)` 但不 `return` | 返回值丢失 → 判决被吞 | `return next(...)` |
| 在 `agent/request` 里 `Object.assign(input.request, ...)` | 改到冻结对象（严格模式抛错）/ 改到共享请求 | 返回 `{...input, request: {...}}` |
| 在 `llm/stream` 里 `for await` 消费了流却不 yield | 主循环收不到分片 | 包裹后 `yield` 出去 |
| 在 `agent/turn-stopping` 里 `throw` | 本 turn 以 `failed` 收尾并向上抛（`turn/end` 已由兜底收尾落账） | 用 `stop(reason)` 表达判停 |
| 自己拼 `messages` 调 adapter | 影子历史漂移（回放对不上） | 只走 `AgentLoop`（历史由 `buildModelHistory` 派生） |
| 直接改 `session.append` 的入参对象 | 日志被后续改动污染 | 落账前 `Object.freeze` / 传新对象 |

## 9. 测试与覆盖率

- 规格用例：`agent-loop/agent.test.ts`（T-LOOP-001~011、013）、`rollback.test.ts`（T-LOOP-012）、
  `inbox.test.ts` / `interrupt.test.ts` / `request.test.ts` / `tool-calls.test.ts`（补充用例）；
- 覆盖率名单包含 `runtime/agent-loop/`（逐文件行覆盖 100%，`pnpm test:coverage` 强制）；
- 无密钥即可全绿：`@bah/llm/mock` 的脚本化 provider 是主循环集成测试的唯一 provider。
