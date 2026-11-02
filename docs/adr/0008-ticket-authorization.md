# ADR-0008 · 票据携带授权来源（`ticket/*` 载荷加法）

- 状态：**已采纳**（2026-10-30）
- 编号说明：本设计原编号 0006，与**卡片状态迁移事件 ADR**（`docs/adr/0006-card-state-event.md`）撞号；
  五线合流时改号为 0008。卡片事件仍占 0006（`docs/adr/0007-subscription-domain-events.md` 的
  「前置：ADR-0006（卡片，19→20）」依赖这一编号），故本设计顺延到 0008。
- 关联：`BAH-跨场景主动能力补全-2026-10-30/02-修复方案-技术最优版-2026-10-30.md` §3.1、`docs/contracts/event-table.md` §4.2

---

## 1 背景

跨场景主动能力要求"用户不在场时，计划按授权窗口执行"。审计上必须回答一个问题：
**这张票据是谁批的？**

现状：`TicketIssuedData` / `TicketApprovedData`（`packages/interaction/src/approval/events.ts`）
只有 `ticketId / callId / name / fingerprint / amountCents? / expiresAt / at`，
`ApprovalInputLike`（`types.ts`）没有携带"授权来源"的口。窗口代签与用户点击在凭证上不可区分。

## 2 决策

在**三个既有结构**上各加一个**可选**字段 `authorization`：

| 结构 | 位置 | 语义 |
|---|---|---|
| `AuthorizationRef` | `interaction/src/approval/types.ts`（新类型） | `{ kind:'human'|'window'; ref:string; digest:string }` |
| `TicketIssuedData.authorization?` | `interaction/src/approval/events.ts` | 签发时的授权来源（窗口代签时 = 窗口 id + 判决摘要） |
| `TicketApprovedData.authorization?` | 同上 | 批准时的授权来源 |
| `ApprovalInputLike.authorization?` | `types.ts` | 管线 → 审批服务 → 治理面 的传递口 |

传递链（全部为可选参数，缺省 = `human`）：

```text
tools/pre-execute ask.authorization
  → ToolPipeline.approve() → approval/request Input.authorization
  → bank governance 审批桥接 → TicketLifecycle.issue/approve(..., authorization)
  → ticket/issued / ticket/approved 载荷
```

**不加事件键、不改既有字段名与类型、不给任何字段加默认值语义。**

## 3 为什么是加法而不是新事件

- 新键 `plan/delegated` 要么占用"领域新键"名额（event-table §4.2 的唯一一次已用掉），
  要么成为第二个真相源（`verify-cross-scene` I1/I2 就是拦这个的）；
- 可选字段缺省即"人工签署"——这是对老行为的**准确描述**，不是新语义；
- 8 份既有快照零重录：回放读不到该字段 → `undefined` → 渲染为"人工"。

## 4 兼容性与回滚

| 面 | 影响 |
|---|---|
| 旧 jsonl | 零迁移（字段缺省） |
| 回放 | `authorization === undefined` → 视为 `human`，不抛错 |
| 快照 | 不重录；只有 `snapshots/proactive/` 的新会话会携带 |
| 门禁 | `verify-session-events` 键集合不变；新增 `verify-proactive` I13 校验 digest 可重算 |

回滚：三处可选字段与传递链全删，无调用方依赖（缺省路径不变）。

## 5 判决可重算（这条决定的另一半）

`digest` 不是任意字符串，是 `WindowVerdictInputs` 的规范化摘要：

```ts
{ balanceCents, factVersions, planState, at, budgetCents }
```

回放时用同一份 inputs 重算 `checkWindow()`，结论必须一致（门禁 I13）。
**没有这一步，`authorization` 只是又一个"自称"字段。**

## 6 复核

```bash
sed -n '18,60p' packages/interaction/src/approval/events.ts        # 可选字段，键集合不变
grep -n "authorization" packages/interaction/src/approval/types.ts # 传递口
pnpm exec tsx scripts/verify-session-events.ts                     # 19 键不变
```
