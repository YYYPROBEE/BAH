# 事件表 · 冻结 v1.0.5

> **冻结版本号**：`v1.0.5-frozen-2026-11-01`
> （v1.0.0 → v1.0.1：按 ADR-0003 追加 `card/reported-lost` / `sub/cancelled` 两个银行领域键；
> v1.0.1 → v1.0.2：按 ADR-0007 追加 `read/subscriptions` / `sub/authorization-revoked` /
> `sub/watch-updated` 三个订阅领域键；按 ADR-0006 追加 `card/state-changed` 一个键；19 → 23；
> v1.0.2 → v1.0.3：按 **ADR-0014** 追加 `security/password-changed` /
> `read/password-status` 两个键；代码口径 34 → **36**；
> v1.0.3 → v1.0.4：按 **ADR-0016** 追加 `proactive/reminder` 一个键；代码口径 36 → **37**；
> v1.0.4 → v1.0.5：按 **ADR-0017** 追加 `aa/participant-updated` 一个键；代码口径 37 → **38**）
> **冻结**：ADR-0001 · **消费方**：各领域事件；**改签**：ADR-0003 / ADR-0006 / ADR-0007
> **代码真相源**：既有 7 个 `plan/*` 在 `packages/runtime/src/plan/events.ts`（第 7 个 `plan/resumed` 已通电）；
> 7 个新键由各消费方在自己的声明面落表（含已通电的两个 bank 键）。
> **变更流程**：见 §4。

## 1. 为什么先冻结事件而不是先写功能

`docs/preflight-2026-10-25.md` 实测：20 项技术项里 **16 项未做**，其中 4 个单都要新增事件。
让后置单各自起名，必然出现"同义异名"（`safety/halt` vs `safety/halted`）与"载荷漂移"。

⇒ 本表把 **7 个新键 + 1 处枚举扩展** 的完整载荷一次写死。
其中 5 个是冻结键，2 个是按 **ADR-0003** 改签的银行领域键（已签字部分见该 ADR §5）。

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
> **`status` 判定铁律**（已记）：`blocked > 0` 必须落 `'failed'`，否则全被 block 的计划会报成功。

## 3. 新增的 7 个键 + 1 处枚举扩展（冻结）

| # | 键 | 来源单 | 载荷（冻结，**一个字段都不许加减**） | 发射方式 |
|---|---|---|---|---|
| 1 | `safety/assertion` | —| `{ planId?: string; turnId: string; total: number; verified: number; needsEvidence: number; rejected: number; at: number }` | `session.append(...)` |
| 2 | `safety/halt` | —| `{ reason: 'chain-broken' \| 'p0-threshold' \| 'manual'; detail?: string; at: number }` | `session.append(...)` |
| 3 | `safety/unfreeze` | —| `{ ticketId: string; mfa: true; at: number }` | `session.append(...)` |
| 4 | ~~`plan/resumed`~~ | —| 已通电：移入 §2（载荷未变，`{ planId: string; digest: string; skipped: number; resumedFrom: readonly string[]; at: number }`） | `session.appendDomain(...)` |
| 5 | `plan/node-waiting` | —| `{ planId: string; nodeId: string; waitedMs: number; at: number }` | `session.appendDomain(...)` |
| 6 | `card/reported-lost` | ADR-0003） | `{ cardId: string; tail: string; status: 'lost'; at: number }` | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)` |
| 7 | `sub/cancelled` | ADR-0003） | `{ subscriptionId: string; merchant: string; at: number }` | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)` |
| 8 | **扩展** `plan/aborted.reason` | —| 枚举 `'cancelled' \| 'timeout' \| 'disposed'` **追加** `'halted'` | 改 `events.ts` 的 `PlanSessionEventMap` |
| 9 | `read/subscriptions` | 场景 5（ADR-0007） | `{ result: SubscriptionListResult; detectedAt: number; basis: { from: number; to: number; txnCount: number }; detectorVersion: string }` | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)` |
| 10 | `sub/authorization-revoked` | 场景 5（ADR-0007） | `{ authorizationId: string; merchant: string; affected: number; at: number }` | 同上 |
| 11 | `sub/watch-updated` | 场景 5（ADR-0007） | `{ subscriptionId: string; watch: 'remind' \| 'idle' \| 'none'; aheadDays?: number; at: number }` | 同上 |
| 12 | `card/state-changed` | 场景 4（ADR-0006） | `{ cardId: string; tail: string; from: 'normal' | 'frozen'; to: 'normal' | 'frozen'; reason: 'freeze' | 'unfreeze'; note?: string; at: number }` | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)` |
| 13 | `security/password-changed` | ADR-0014） | `{ userId: string; method: 'secure-page'; at: number }`（**禁止**旧密码 / 新密码 / 哈希 / 盐 / 明文变形） | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)`；发射点 `packages/bank/src/tools/password.ts` 的 `createPasswordHandoffPort().submit()` |
| 14 | `read/password-status` | ADR-0014） | `{ lastChangedAt: number \| null; remainingAttempts: number; at: number }` | 同上；发射点 `readPasswordStatus()`（只读分支，登记在 `READ_ONLY_ACTIONS`） |
| 15 | `proactive/reminder` | ADR-0016） | `{ source: string; key: string; title: string; channel: 'in-app' \| 'im' \| 'none'; suppressedReason?: string; at: number }`（`channel='none'` 时必须带 `suppressedReason`；**不落** `text` / `level`） | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)`；发射点 `packages/host/src/boot/plugins/proactive.ts` 的 `createProactiveService().push()`（非工具插件，经 `bank:audit` 服务拿到同一份发射面） |
| 16 | `aa/participant-updated` | ADR-0017） | `{ groupId: string; participantIndex: number; from: 'pending'; to: 'declined' \| 'expired'; at: number }`（**不放姓名/手机号**；不复用 `aa/collected`，也不加 `aa/expired`） | `deps.audit.append(...)` → `session.appendDomain(..., ignorable: true)`；发射点 `packages/bank/src/tools/aa.ts`（decline/close）与 `packages/host/src/boot/plugins/aa-expiry.ts`（到期 job） |

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
且通过对应门禁的反向覆盖。本设计**只落表，不发射**——`safety/*` 与 `plan/resumed` /
`plan/node-waiting` 的发射点是 后续迭代 的验收项。

**例外已通电**：第 6、7 两行由实现并验收（`packages/bank/src/tools/account-ops.ts`
的 `deps.audit.append('card/reported-lost' | 'sub/cancelled', …)`，字面量发射）；
第 9–11 三行由场景 5（ADR-0007）在 `packages/bank/src/tools/{subscriptions,account-ops}.ts`
通电；第 12 行由场景 4（ADR-0006）在 `packages/bank/src/tools/account-ops.ts` 通电；
`packages/bank/src/tools/events.ts` 的 map 与 `BANK_SESSION_EVENT_TYPES` 已同步到 23 键。

### 3.4 `approval/asked` 载荷的**可选字段**扩展（2026-10-31，不新增键）

> 键数不变（仍 23），事件表 §3 的"一个字段都不许加减"针对**新增键的冻结载荷**；
> 本节记录的是既有平台事件的**可选增量**，形状为向下兼容（老载荷/老回放无需迁移）。

| 事件 | 追加字段 | 类型 | 语义 |
|---|---|---|---|
| `approval/asked` | `details?` | `readonly TicketDetail[]`（`{ label: string; value: string; emphasis?: 'amount' \| 'date' \| 'risk' }`） | 服务端签发的操作明细，**只用于展示**；不参与参数指纹、票据绑定与核销判决 |

- **声明点**：`packages/runtime/src/session/types.ts` 的 `SessionEventMap['approval/asked']`
  （类型来自 `@bah/core` 的 `api.ts`，`TicketDraft.details` / `TicketRef.details` 同源）。
- **发射点**：`packages/runtime/src/tools/pipeline.ts` 的 `approve()`——把 `TicketDraft.details`
  原样搬进事件与 `ApprovalInput.summary.details`，管线不做任何重算。
- **生产者**：`packages/bank/src/tools/governance.ts` 的 `ask` 分支调用
  `detailsForCall(...)`（`packages/bank/src/tools/approval-details.ts`），数值一律 `deps.core` 现读。
- **消费者**：`packages/channels/src/web/project.ts`（帧原样投影）、
  `packages/channels/src/web/audit.ts`（摘要纳入标签集合）、`apps/im-gateway/src/approval/{texts,page}.ts`。
- **不变量**：`details` 缺省时事件形状与 v1.0.2 完全一致（`Object.keys` 不出现该键）。

### 3.5 `card/issued` / `card/limits-changed` 载荷的**可选字段**扩展（2026-11-01，不新增键）

> 键数不变（仍 36）。§3 的"一个字段都不许加减"针对**新增键的冻结载荷**；本节记录的是既有
> 卡片事件的**可选增量**，形状向下兼容——借记卡（`kind` 缺省）发射的事件与 v1.0.3 逐字一致，
> 老载荷/老回放无需迁移。

| 事件 | 追加字段 | 类型 | 语义 |
|---|---|---|---|
| `card/issued` | `creditLimitCents?` | `number`（整数分） | 本次签发的是**信用产品**（`kind='credit'`）时才有 |
| `card/limits-changed` | `creditLimitCents?` | `number`（整数分） | 变更后的授信额度；仅信用产品 |
| `card/limits-changed` | `usedCreditCents?` | `number`（整数分） | **变更时**的已用额度；仅信用产品 |

- **声明点**：`packages/bank/src/tools/events.ts` 的
  `BankSessionEventMap['card/issued']` / `['card/limits-changed']`。
- **发射点**：`packages/bank/src/tools/account-ops.ts` 的 `createCardApplyTool` /
  `createCardLimitSetTool`（`deps.audit.append('card/issued' | 'card/limits-changed', …)` 字面量）。
- **为什么 `usedCreditCents` 要进事件**：额度调整的合法性取决于"已用多少"（降额不得低于已用）；
  不落这个数，事后回放无法解释一次降额为什么被允许或被拒。
- **不变量**：
  1. 借记卡路径的 `Object.keys` 与 v1.0.3 完全一致（这两个字段**只在信用产品上出现**）；
  2. `usedCreditCents` 是**变更时的快照**，不随下一笔消费更新——事件是事实，不是实时镜像。
- **不占改签名额**：这是既有键的可选增量，不是新增键（§4.2 的"改载荷"针对必填字段增删）。

## 4. 变更流程

1. **加键**：写 ADR + L1 owner 签字 + 在本表追加一行（含"发射方式"列）；
2. **改载荷**：属**改签**，必须 ADR；每个键只给**一次**改签名额（§5 风险表）；
3. **改名**：禁止。事件名是契约，改名等于让历史日志失去可解释性；
4. **`plan/aborted.reason` 加 `'halted'` 是改签**：见 `docs/adr/0002-plan-abort-halted.md`，
   **实现方开工的前提**，无 ADR 就改 `events.ts` = 违规。

## 5. 本表之外一概不批

需要第 8 个新键就在该单的"偏差"里申请。**实现方之后（D2 起）不再受理新键申请**
——事件表一松，`verify-*-events` 的三个门禁全部失去意义。

> **已用的三次领域改签**：ADR-0003 的 `card/reported-lost` / `sub/cancelled`（实现方，2026-10-25）；
> ADR-0006 的 `card/state-changed`（场景 4，2026-10-30，19 → 20）；
> ADR-0007 的 `read/subscriptions` / `sub/authorization-revoked` / `sub/watch-updated`（场景 5，2026-10-30，20 → 23）。
> （ADR-0008「票据携带授权来源」只加**载荷字段**，不占事件键名额，故不计入改签。）
>
> **ADR-0009（风险测评服务端问卷，2026-10-31）**：新增 `read/risk-questions` 一个键，
> 并给 `risk/assessed` 加确认凭证字段（`questionnaireId` / `version` / `confirmedBy` /
> `ticketRef` / `answers`）。键数 31 → **32**。
>
> **ADR-0012（卡消费通道，2026-10-31）**：新增 `card/spent` 一个键，
> 载荷 `{ cardId, tail, txnId, merchantCategory, amountCents, at }`（账本事实，
> 不含限额结论——限额会随下一笔漂移，落进来就是第二份真相）。键数 32 → **33**。
>
> **ADR-0011（AA 收口，2026-11-01）**：新增 `aa/collected` 一个键，
> 载荷 `{ groupId, participantIndex, collectedCents, txnId, at }`（账本事实，
> 不含姓名/手机号——姓名已在组快照里）。`read/aa` 从"黄档查询"转为
> `aa_create(action="status")` 的只读分支（`READ_ONLY_ACTIONS` 第二条）。
> 键数 33 → **34**。
>
> **ADR-0014（交易密码交办，2026-11-01）**：新增 `security/password-changed` 与
> `read/password-status` 两个键。前者载荷**只有** `{ userId, method: 'secure-page', at }`——
> 密码明文/哈希/盐一律不进事件（这是本 ADR 的第一条判据）；后者是
> `password_change(action="status")` 的只读分支（`READ_ONLY_ACTIONS` 第三条）。
> 键数 34 → **36**。
>
> **ADR-0015（信用卡授信额度，2026-11-01）**：**零新增键**（仍 36）。只给
> `card/issued` / `card/limits-changed` 加可选字段（见 §3.5），属"载荷可选增量"，
> 不占 §5 的改签名额；借记卡发射的事件形状不变。
>
> **ADR-0016（通用主动通知通道，2026-11-01）**：新增 `proactive/reminder` 一个键。
> 键名刻意**不是** `sub/*`——实现方（生日）复用同一条通道，泛化名字才不需要二次改签；
> `source` 取 `string` 而不是封闭联合，同理。`channel='none'` 时必须带 `suppressedReason`
> （夜里被静默这件事要在审计里可解释）；`text` / `level` **不进载荷**，因此也不渲染。
> 键数 36 → **37**。
>
> **ADR-0017（AA 参与人状态机，2026-11-01）**：新增 `aa/participant-updated` 一个键，
> 表达 `pending → declined | expired`。**不复用 `aa/collected`**（那是"钱进来了"）、
> **不加 `aa/expired` 第二个键**（`to` 已表达去向）；载荷不含姓名/手机号。
> 到期收口由 `aa-expire` job 发射，decline/close 由 `aa_create` 发射。
> 键数 37 → **38**。
>
> ⚠ **已知文档债务（不掩盖）**：本表正文仍停在 ADR-0007 时点的 23 键，
> 此后卡片补全（`card/issued` / `card/limits-changed` / `card/restrictions-changed`）与
> 订阅交付前新增的键**没有逐条登记在本表**。键数与清单以代码为准：
> `packages/bank/src/tools/events.ts` 的 `BANK_SESSION_EVENT_TYPES`（现 38 键），
> `verify-session-events` 会扫 `audit.append('…')` 字面量并核对本文件的增强块。
> 本次补 `card/spent` 与 `read/risk-questions`，不追溯补登历史键。

## 6. 自检（TC-04 / 06）

```bash
npx tsx scripts/verify-plan-events.ts      # 既有 6 键未被顺手改名/改载荷
npx tsx scripts/verify-session-events.ts   # safety/* 走 append 且键表已声明
```
