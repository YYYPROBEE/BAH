# ADR-0007 · 订阅代扣场景新增三个领域事件

- 状态：**已批准（Accepted）**
- 日期：2026-10-30
- 版本：v1.0.2-frozen（19 → 22 键）
- 提案：场景 5
- 前置：ADR-0006（卡片，19→20）若先合，本设计顺延 20→23
- 相关：`docs/contracts/event-table.md`、`docs/adr/0003-bank-lifecycle-events.md`

## 1. 背景

场景 5 要新增三个动作：查订阅清单（含周期检测）、**关闭**代扣协议（恢复走引导，不做「开」）、
设置提醒标记。`BankToolSpec.event` 是封闭联合，现有 19 键无一能表达这三件事：

| 想复用的键 | 为什么不行 |
|---|---|
| `read/txns` | 载荷是 `TxnQueryResult`。审计问「用户当时看到哪几个订阅、哪个置信度」答不上 |
| `sub/cancelled` | 语义是「退订某订阅」，载荷只有 `subscriptionId+merchant`。关协议影响该商户 N 个订阅，记成一条取消会让「影响面」永久丢失 |
| 任意 `read/*` | 提醒标记是**写**，不可回放即不可审计 |

## 2. 决策

| 键 | 载荷（冻结） | 发射方式 | 语义 |
|---|---|---|---|
| `read/subscriptions` | `{ result: SubscriptionListResult; detectedAt: number; basis: { from: number; to: number; txnCount: number }; detectorVersion: string }` | `deps.audit.append(...)` | 订阅清单 + 周期检测结果已读取（推断三件套让回放能识别这是快照） |
| `sub/authorization-revoked` | `{ authorizationId: string; merchant: string; affected: number; at: number }` | `deps.audit.append(...)` | 代扣协议已关闭（黄档写，可逆） |
| `sub/watch-updated` | `{ subscriptionId: string; watch: 'remind' \| 'idle' \| 'none'; aheadDays?: number; at: number }` | `deps.audit.append(...)` | 订阅提醒/标注已更新（**黄档**写） |

## 3. 为什么这算改签、且必须走 ADR

event-table §5 原文「此后即便银行侧再加工具，也不得再顺手加事件」。ADR-0003 用掉了「领域新键」的
一次性名额。本设计是**第二次**改签，必须重新举证：三个动作各自对应一种审计问句，复用即撒谎。
**批准即视为「订阅/代扣」这一场景整体纳入事件契约；此后该场景不再单独申请。**

### 3.1 与 ADR-0003 的关系

ADR-0003 §3 写「本 ADR 是**唯一一次**针对『领域新键』的改签，用掉即止」。本 ADR 不否认那句话，
而是澄清它的**时效**：它指的是 0003 当时那一次额度，不构成永久禁令。

依据在事件表自身的 §5——标题虽写「本表之外一概不批」，正文明确留了口子：
「必须复用既有 19 键**或走 ADR 重新申请**」。本设计走的正是这条路径。

⇒ **落地动作**：在 `docs/adr/0003-bank-lifecycle-events.md` §3 末尾加一行后注指向本 ADR，
避免只读 0003 的人被「唯一一次」误导。**不改** `event-table.md` §5 的措辞。

## 4. 实现约束

1. 发射点必须是字符串字面量（`verify-session-events` AST 扫 `audit.append(`）；
2. 三键各需至少一个真实发射点（宪法 §3.2「通电才算完成」）；
3. `at` 取注入钟（`clockOf(deps)`），不许 `Date.now()`；
4. `sub_cancel` 的既有载荷**不变**（`{subscriptionId, merchant, at}`），本 ADR 不改它；
5. 三个新键进 `BANK_SESSION_EVENT_TYPES` 末尾，顺序 = 上表顺序；
6. `read/subscriptions` 的 `result` 里 `detected[]` 是**推断**：`detectedAt / basis / detectorVersion`
   三件套必须同时落账，且卡片渲染「基于近 N 天 X 笔流水，生成于 Y」。

## 5. 签字位

| 角色 | 签字含义 | 状态 |
|---|---|---|
| 提案 | 证明 19 键覆盖不了 | ✅ 2026-10-30（场景 5） |
| 批准 | 同意第二次改签 | ✅ 2026-10-30（拍板「批准 3 键」） |
| 会签（eval/重放） | 确认不破坏场景与回放基线 | ⏳ 待补 |

## 6. 后果

正面：订阅场景有了可审计的三态（看 / 断 / 提醒），「硬断供」从话术变成可查记录。

负面：事件表第二次松动，评审会问「为什么不能一次想清楚」——对外说明口径：
**第一次改签（ADR-0003）是补两个孤立动作；本次是把一个场景的完整生命周期纳入契约，性质不同。**
