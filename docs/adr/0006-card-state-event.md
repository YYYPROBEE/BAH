# ADR-0006 卡片状态迁移事件（ADR-0003 改签）

- 状态：提议
- 日期：2026-10-30
- 关联：ADR-0003（银行生命周期事件，v1.0.1-frozen，19 键）

## 背景

场景 4 实现需要 `card_freeze`（黄）/ `card_unfreeze`（红）两个工具。
`catalog.test.ts` 要求工具 spec 的 event 必须已声明；现有 19 键中没有能表达
"卡从 normal 到 frozen（及反向）"的键，而 `card/reported-lost` 的载荷写死 lost。

## 决定

新增 1 个键 `card/state-changed`（19 → 20），载荷带 `from/to/reason`：

```text
{ cardId, tail, from: 'normal'|'frozen', to: 'normal'|'frozen', reason: 'freeze'|'unfreeze', note?, at }
```

`note` 是可选的原因文本（只落审计，不参与判定）；没有就省略，不写空串。

不新增 `card/frozen` / `card/unfrozen`：同一状态边的两个方向用一个键 + `from/to` 表达，
回放器只需一个 reducer。

## 影响

- `packages/bank/src/tools/events.ts`：map + 常量数组各加一条；
- `docs/contracts/event-table.md`：表加一行，键数 19 → 20；
- 既有 19 键**不改名、不改载荷**（`card/reported-lost` 保持原样）；
- `verify-session-events` 通过（新字面量已声明）。

## 幂等

`changed === false` 的重复调用**不发**事件：重复点击的事实由 `tool/result` 记录，
不得用 `from === to` 的伪迁移污染状态回放链。

## 不做

不把 `lost` 并入本键：挂失是不可逆链路起点，语义与"可逆冻结"不同，
合并会让审计看不出"这张卡还能不能解冻"。
