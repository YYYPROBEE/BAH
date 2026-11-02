# ADR-0002 · `plan/aborted.reason` 追加 `'halted'`

- **状态**：已接受（Accepted）
- **日期**：2026-10-26
- **版本**：`v1.0.0-frozen-2026-10-26`（与 ADR-0001 同批）
- **决策者**：项目负责人
- **相关**：`docs/contracts/event-table.md` §3

## 1. 背景

HALT 闭环需要一个"被人为叫停"的中止原因，而 `plan/aborted.reason` 的现有枚举只有三个：

```ts
// packages/runtime/src/plan/events.ts:97
readonly reason: 'cancelled' | 'timeout' | 'disposed'
```

三者都不覆盖 HALT：
- `cancelled` 是**计划发起方主动取消**（用户说不做了）；
- `timeout` 是**超时**（`planTimeoutMs` 到点）；
- `disposed` 是**插件卸载**（会话结束）。

HALT 是**治理面强制叫停**（`safety/halt` 触发后，在跑的 plan 必须中止）。语义不同、追责不同：
审计追问"这笔计划为什么停了"，答"cancelled"会被理解成用户取消，那是错的。

## 2. 决策

**在枚举里追加 `'halted'`，不改其余三个，不改字段名，不改载荷其他部分。**

```ts
readonly reason: 'cancelled' | 'timeout' | 'disposed' | 'halted'
```

**落到两处**（两处必须同时改，只改一处会让门禁与类型打架）：
1. `packages/runtime/src/plan/events.ts:97` 的 `PlanSessionEventMap['plan/aborted'].reason`；
2. `packages/runtime/src/plan/types.ts:96` 的 `PlanAbortReason`。

## 3. 这条为什么必须走 ADR（而不是"顺手加个字面量"）

它是**改签**。ADR-0001 已经宣布"事件表之后只增不改"，而加枚举值属于**改已有键的载荷**。
若允许"加个值不算改签"，那下一步就允许"加个可选字段也不算"，事件表的冻结当天失效。

⇒ 本 ADR 就是那**一次**改签。**用完即止。**

## 4. 实现约束

1. **不许在 `packages/runtime/src/plan/` 里加判断 `'halted'` 的分支**。
   理由：HALT 的判定在 `tools/pre-execute` 的 sentry 监听器内（在 `next()` 之前返回 deny），
   属于**治理面**；让 plan 引擎认识 HALT 会把治理语义拖进编排包，违反 R-4 的 import 边界。
2. **`'halted'` 由宿主写入，不由引擎产生**：宿主在 `run()` 之前拦截，直接落
   `plan/completed(status='aborted')` + `plan/aborted(reason='halted')`，引擎零 diff。
   （这是 v2 的定稿口径，初版"让引擎自然 failed"是错的。）
3. **`plan/aborted` 的 `at` 取注入钟**，不许 `Date.now()`（`verify-plan-determinism` 会红）。
4. 加了枚举值之后，`verify-plan-events` 的**反向覆盖**必须仍然通过——
   `'halted'` 需要一个真实发射点，否则就是"声明了没通电"（宪法 §3.2）。

## 5. 后果

**正面**：审计能区分"用户取消"与"治理叫停"，这是异常熔断的举证点。

**负面**：
- 6 个既有 `plan/*` 事件里，`plan/aborted` 是**唯一**一个载荷被扩展过的；
  历史日志里不会出现 `'halted'`，读旧日志的工具必须容忍"值域比代码窄"。
- 本 ADR 用掉了事件表的那一次改签名额。此后若发现载荷不够，
  **必须走新的 ADR**，不能再引用本文件。

## 6. 改签约定

事件表载荷只增不改；新增枚举值也必须单独出 ADR。
