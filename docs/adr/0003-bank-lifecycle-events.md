# ADR-0003 · 银行领域新增两个生命周期事件（挂失 / 退订）

- **状态**：已接受（Accepted）
- **日期**：2026-10-25
- **版本**：`v1.0.1-frozen-2026-10-26`（事件表 17 → 19 键）
- **提案**：工具契约 + 两个新工具
- **批准**：项目方 2026-10-25 明确选择方案 A（新增事件，而非把工具移出契约）
- **相关**：`docs/contracts/event-table.md`

## 1. 背景

业务需要新增两个工具：`card_report_lost`（红档）、`sub_cancel`（黄档）。

障碍：`BankToolSpec.event` 的类型是 `BankSessionEventType`，即
`packages/bank/src/tools/events.ts` 里 **17 个键的封闭联合**（`identity/bound` …
`ticket/ledger-failed`）。**没有任何一个键能表达"挂失"或"退订"**。

拿 `read/*` 顶替是**撒谎**：审计追问"这笔挂失记在哪个事件"，答不上来；
而"事件载荷就是卡片的数据源"（§4）意味着错的事件会让卡片展示也失真。

## 2. 决策

**新增两个银行领域事件，不改动既有 17 个键中的任何一个。**

| 键 | 载荷（冻结） | 发射方式 | 语义 |
|---|---|---|---|
| `card/reported-lost` | `{ cardId: string; tail: string; status: 'lost'; at: number }` | `audit.append(...)` | 银行卡挂失（红档写操作，必须审批 + 强验证） |
| `sub/cancelled` | `{ subscriptionId: string; merchant: string; at: number }` | `audit.append(...)` | 取消自动扣款订阅（黄档写操作） |

两处必须同时改，只改一处会与门禁打架：
1. `packages/bank/src/tools/events.ts` 的 `BankSessionEventMap`；
2. 同文件的 `BANK_SESSION_EVENT_TYPES` 数组（顺序即声明顺序，追加到末尾）。

## 3. 为什么这算改签、且为什么必须走 ADR

`docs/contracts/event-table.md` §5 写着「本表之外一概不批……冻结后不再受理新键申请」。
新增工具与这条直接冲突。**冲突不能靠"改文档"自动解除**——
事件表一旦松动，`verify-session-events` 的「声明集合 ↔ 发射点」对账就失去意义。

⇒ 本 ADR 是**唯一一次**针对"领域新键"的改签，用掉即止。

## 4. 实现约束

1. **发射点必须是字面量**：`deps.audit.append('card/reported-lost', {…})`。
   `verify-session-events` 用 AST 扫 `audit.append(` 的**字符串字面量**，动态名直接失败。
2. **两个键各需至少一个真实发射点**：只声明不发射 = 违反宪法 §3.2（"通电"才算完成）。
3. **不改 `BankCoreProvider` 之外的东西**：挂失/退订的写入口加在
   `packages/bank/src/core/provider.ts` 的 `BankCoreProvider` 接口上，由 `MockBankCore` 实现。
   工具层只组装参数、调 core、落事件，**不自己改数据结构**。
4. **`at` 取注入钟**（`clockOf(deps)`），不许 `Date.now()`。
5. **金额无关**：两个工具都不涉及 `amount`，因此不进 `verify-tiers` 的 `amountPath` 校验。
6. **档位**：`card_report_lost` = `red`（不可逆的资产处置），`sub_cancel` = `yellow`（可逆的授权撤销）。
   档位由 `spec.tier` 声明，**工具内不许自带阈值**（既有纪律）。

## 5. 兼容性

新增键只追加到封闭联合末尾，不改既有 17 键；`verify-session-events` 的「声明集合 ↔ 发射点」对账仍然成立。
读旧日志的工具要容忍"值域比代码窄"——历史日志里不会出现这两个键。

## 6. 后果

**正面**：两个赛题场景（挂失、退订）有了真实工具与真实落账；事件表从"写死的 17 键"变成
"19 键 + 一次有据可查的改签"，这本身是可审计性的证据。

**负面（必须承认）**：
- 读旧日志的工具要容忍"值域比代码窄"——历史日志里不会出现这两个键；
- `docs/contracts/event-table.md` 的 §3 表格要从 5 行变 7 行，版本号升位；
- 场景集里若已有"挂失/退订"的占位场景，ID 需对齐本 ADR 的工具名。

## 7. 后注（2026-10-30）

§3 的「唯一一次」指 ADR-0003 当时那一次「领域新键」额度，**不构成永久禁令**。
场景 5 已按事件表 §5 的「走 ADR 重新申请」路径完成**第二次**改签：
见 `docs/adr/0007-subscription-domain-events.md`（19 → 22 键，2026-10-30 批准）。
本 ADR 的载荷与签名状态不变。
