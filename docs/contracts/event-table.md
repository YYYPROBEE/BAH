# 事件表 · 冻结 v1.0.1

> **冻结版本号**：`v1.0.1-frozen-2026-10-26`
> （v1.0.0 → v1.0.1：按 ADR-0003 追加 `card/reported-lost` / `sub/cancelled` 两个银行领域键，
> **用掉"领域新键"唯一一次改签名额**；L1-A 技术签署位见 ADR-0003 §5）
> **冻结单**：W02 · **消费单**：W05 / W07 / W10 / W11；**改签单**：W03（ADR-0003）
> **代码真相源**：既有 7 个 `plan/*` 在 `packages/runtime/src/plan/events.ts`（第 7 个 `plan/resumed` 由 W10 通电）；
> 7 个新键由各消费单在自己的声明面落表（含 W03 已通电的两个 bank 键）。
> **变更流程**：见 §4。

## 1. 为什么先冻结事件而不是先写功能

`docs/preflight-2026-10-25.md` 实测：20 项技术项里 **16 项未做**，其中 4 个单（W05/W07/W10/W11）都要新增事件。
让后置单各自起名，必然出现"同义异名"（`safety/halt` vs `safety/halted`）与"载荷漂移"。

⇒ 本表把 **7 个新键 + 1 处枚举扩展** 的完整载荷一次写死。
其中 5 个是 W02 冻结键，2 个是 W03 按 **ADR-0003** 改签的银行领域键（已签字部分见该 ADR §5）。

## 2. 已冻结的 7 个 `plan/*`（**一个名字都不许改**）

| 键 | 载荷（冻结） | 门禁 |
|---|---|---|
| `plan/created` | `planId, nodes, edges, dryRun, digest, initiator, at` | `verify-plan-events` |
| `plan/resumed` | `planId, digest, skipped, resumedFrom[], at` | 同上 |
| `plan/node-started` | `planId, nodeId, tool, ordinal, callId, at` | 同上 |
| `plan/node-result` | `planId, nodeId, status('succeeded'\|'failed'\|'skipped'), code?, digest?, durationMs, at` | 同上 |
| `plan/node-blocked` | `planId, nodeId, blockedBy[], reason('upstream-failed'\|'upstream-blocked'\|'upstream-cancelled'), at` | 同上 |
| `plan/completed` | `planId, status('succeeded'\|'failed'\|'aborted'), total, succeeded, failed, blocked, skipped, cancelled, durationMs, at` | 同上 |
| `plan/aborted` | `planId, reason('cancelled'\|'timeout'\|'disposed'\|'halted'), atNode?, at` | 同上 |

> 这张表照 `packages/runtime/src/plan/events.ts` 的 `PlanSessionEventMap` 逐字抄的，不是转述。
> **`status` 判定铁律**（W01 已记）：`blocked > 0` 必须落 `'failed'`，否则全被 block 的计划会报成功。

## 3. 新增的 7 个键 + 1 处枚举扩展（冻结）

| # | 键 | 来源单 | 载荷（冻结，**一个字段都不许加减**） | 发射方式 |
|---|---|---|---|---|
| 1 | `safety/assertion` | W05 | `{ planId?: string; turnId: string; total: number; verified: number; needsEvidence: number; rejected: number; at: number }` | `session.append(...)` |
| 2 | `safety/halt` | W07 | `{ reason: 'chain-broken' \| 'p0-threshold' \| 'manual'; detail?: string; at: number }` | `session.append(...)` |
| 3 | `safety/unfreeze` | W07 | `{ ticketId: string; mfa: true; at: number }` | `session.append(...)` |
| 4 | ~~`plan/resumed`~~ | W10 | 已通电：移入 §2（载荷未变，`{ planId: string; digest: string; skipped: number; resumedFrom: readonly string[]; at: number }`） | `session.appendDomain(...)` |
| 5 | `plan/node-waiting` | W11 | `{ planId: string; nodeId: string; waitedMs: number; at: number }` | `session.appendDomain(...)` |
| 6 | `card/reported-lost` | W03（ADR-0003） | `{ cardId: string; tail: string; status: 'lost'; at: number }` | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)` |
| 7 | `sub/cancelled` | W03（ADR-0003） | `{ subscriptionId: string; merchant: string; at: number }` | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)` |
| 8 | **扩展** `plan/aborted.reason` | W07 | 枚举 `'cancelled' \| 'timeout' \| 'disposed'` **追加** `'halted'` | 改 `events.ts` 的 `PlanSessionEventMap` |

### 3.1 `append` vs `appendDomain` 不是风格问题，是门禁盲区

`scripts/verify-session-events.ts` 的接收者识别**只认 `append(`**。
用 `appendDomain(` 发的键会**静默逃过**该门禁的"键表声明 + 反向覆盖"检查 —— plan 域已经踩过这个坑，
所以 plan 域额外有 `scripts/verify-plan-events.ts` 覆盖它。

⇒ **纪律**：`safety/*` 一律 `session.append(...)`；`plan/*` 一律 `appendDomain`，但必须同时在
`PLAN_SESSION_EVENT_TYPES` 里声明，否则 `verify-plan-events` 会红。

### 3.2 `at` 一律取注入钟

`Date.now()` 在 `packages/runtime/src/plan/` 是**门禁禁止项**（`verify-plan-determinism`）。
`safety/*` 三个键虽然不在 plan 目录，但同一纪律适用：`at` 从 `bah:run` 的注入钟取。

### 3.3 「通电」的判定

宪法 §3.2：**只声明不发射 = 未完成。** 本表每个键必须由来源单提供**至少一个发射点**，
且通过对应门禁的反向覆盖。W02 本单**只落表，不发射**——`safety/*` 与 `plan/resumed` /
`plan/node-waiting` 的发射点是 W05/W07/W10/W11 的验收项。

**例外已通电**：第 6、7 两行由 W03 实现并验收（`packages/bank/src/tools/account-ops.ts`
的 `deps.audit.append('card/reported-lost' | 'sub/cancelled', …)`，字面量发射）；
`packages/bank/src/tools/events.ts` 的 map 与 `BANK_SESSION_EVENT_TYPES` 已同步到 19 键。

## 4. 变更流程

1. **加键**：写 ADR + L1 owner 签字 + 在本表追加一行（含"发射方式"列）；
2. **改载荷**：属**改签**，必须 ADR；W02 只给每个键**一次**改签名额（§5 风险表）；
3. **改名**：禁止。事件名是契约，改名等于让历史日志失去可解释性；
4. **`plan/aborted.reason` 加 `'halted'` 是改签**：见 `docs/adr/0002-plan-abort-halted.md`，
   **W07 开工的前提**，无 ADR 就改 `events.ts` = 违规。

## 5. 本表之外一概不批

需要第 8 个新键就在该单的"偏差"里申请。**W02 之后（D2 起）不再受理新键申请**
——事件表一松，`verify-*-events` 的三个门禁全部失去意义。

> **唯一已用的例外**：ADR-0003 的 `card/reported-lost` / `sub/cancelled`（W03，2026-10-25）。
> 它用掉了"领域新键"的**一次性**改签名额；此后即便银行侧再加工具，也不得再顺手加事件，
> 必须复用既有 19 键或走 ADR + L1-A 重新申请。

## 6. 自检（TC-W02-04 / 06）

```bash
npx tsx scripts/verify-plan-events.ts      # 既有 6 键未被顺手改名/改载荷
npx tsx scripts/verify-session-events.ts   # safety/* 走 append 且键表已声明
```
