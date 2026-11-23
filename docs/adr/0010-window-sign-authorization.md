# ADR-0010 · 授权窗口的代签边界（`windowResponder` 与 `responder` 正交，删"无差别放行"）

- 状态：**已采纳**（2026-10-31）
- 关联：ADR-0008（票据携带授权来源）、`docs/plan.md` §4、`docs/profile.md`
- 影响面：`packages/host/src/boot/plugins/approval.ts`、`packages/interaction/src/approval/`、
  `profiles/{web,web-plan,plan,headless,subscription}/patch.yml`、`packages/cli/src/cli/plan.ts`、
  `packages/eval/src/scenario/runner.ts`

---

## 1 背景

"用户不在场时按授权窗口执行"要求两件互相拉扯的事同时成立：

1. 计划到点必须能自己往前走（无人值守）；
2. 审计上必须能回答**这张票据凭什么被批**，而不是"profile 里开了个开关"。

改造前的放行面有两个口子，都在 `interaction:approval` 的配置里：

| 口子 | 位置 | 问题 |
|---|---|---|
| `autoDecision` 缺省 `allow` | `packages/host/src/boot/plugins/approval.ts` | "没配置 = 自动放行"——最容易被忽略的一条放行通道 |
| `responder: headless` 的自动应答 | 同上 | 它替**所有**审批点头，不区分"到点唤醒的窗口票据"与"人在当场发起的转账" |

于是 `headless` 一旦打开，人在场发起的转账也会被自动批准。这不是"无人值守"，是"无人审批"。

## 2 决策

> **把"代签"从"自动应答"里拆出来，做成一个独立的、缺省关闭的通道。**

`ApprovalSettings` 变成四个字段（`approval.ts:36-53`）：

| 字段 | 取值 | 缺省 | 语义 |
|---|---|---|---|
| `responder` | `none` / `headless` | **`none`** | 常规应答者。`none` = 没有应答者 = `unavailable` = **拒绝** |
| `autoDecision` | `allow` / `reject` / `cancel` | **`reject`** | 只在 `responder: headless` 时生效 |
| `autoVerify` | `boolean` | `true` | 红级是否先走强验证；`false` 时批准会被审批服务拒绝 |
| `windowResponder` | `boolean` | **`false`** | 是否注册**窗口代签**应答者（`approval.ts:105`） |

关键点：**`responder` 与 `windowResponder` 正交**。
`responder: none` + `windowResponder: true` 是"没有自动放行，但到期唤醒的窗口票据可以代签"——
这正是 plan / web-plan / subscription / headless 四个 profile 要的语义。

**"无差别放行"已删除**：全仓没有任何一格配置能表达"所有审批都批准"。

## 3 为什么不做成 `responder` 的第三个取值

直觉方案是 `responder: 'window'`。放弃它是因为**两个正交维度被一个枚举压扁**：

| 维度 | 回答的问题 |
|---|---|
| `responder` | 除窗口票据外，其他审批找谁应答 |
| `windowResponder` | 窗口票据到点时，允不允许代签 |

压成一个枚举后，"有常规应答者 + 可代签"和"无常规应答者 + 可代签"必须二选一，
而 `headless` 恰恰需要后者（演示环境里除窗口外不该有人应答）。

## 4 配置矩阵（`packages/cli/src/main.smoke.test.ts:92-98` 逐条钉死）

| profile | `responder` | `autoDecision` | `autoVerify` | `windowResponder` | 到点行为 |
|---|---|---|---|---|---|
| `web` | `none` | `reject` | `true` | **`false`** | **弹审批**，等人点 |
| `web-plan` | `none` | `reject` | `true` | `true` | 代签 |
| `plan` | `none` | `reject` | `true` | `true` | 代签 |
| `headless` | `none` | `reject` | `true` | `true` | 代签 |
| `subscription` | `none` | `reject` | `true` | `true` | 代签 |
| `desktop` / `mobile` / `im` / `sdk` | `none` | `reject` | `true` | 未覆盖 | 弹审批 |

`web` 必须是 `false`：**它一开就等于替人点头**，而 Web 的全部价值在于"人真的在场"。
`desktop` / `mobile` / `im` / `sdk` 走 `web` 的同一份 `wire.ts` 应答者
（`packages/host/src/boot/plugins/web/wire.ts:64-70`），因此同样不代签。

## 5 后果

1. **CLI 是人工渠道**：`bah plan arm` 在终端敲下等于本人点了批准
   （`packages/cli/src/cli/plan.ts:261`）。它是"人"，不是"自动"。
2. **评测夹具必须显式写 `allow`**：`packages/eval/src/scenario/runner.ts:331` 起，
   overlay 里不写 `allow` 就得不到批准——这正是想要的，夹具不该搭 profile 的便车。
3. **快照重录时审批走夹具 overlay**：`plan` / `cross-scene` / `subscription-reminder` /
   `birthday-reminder` 四个快照显式放行，不靠生产 profile 的缺省（见 `facts.md` §1）。
4. **不得宣称"headless 自动应答"**：全 profile 的 `responder` 都是 `none`。
   正确表述是"窗口代签"，不是"自动审批"。
5. **授权来源可追**：票据上的 `authorization`（ADR-0008）区分 `human` 与 `window`，
   与本文的通道边界配套——通道决定"谁可以签"，0008 决定"签了之后凭证上写什么"。

## 6 未覆盖面（显式登记）

- `desktop` / `mobile` / `im` / `sdk` 四个 profile 未单独声明 `windowResponder`，
  依赖 `DEFAULT_APPROVAL.windowResponder = false`。要支持无人值守需显式打开并在本文补一行。
- `subscription` 的定时扣款走 `plan:scheduler`，代签生效但端到端**无快照背书**
  （13 份快照 38 次 `tool/call` 里 0 次触发）；不得据此宣称"订阅扣款已自动化验证"。

## 7 补记（2026-11-22）：预授权凭据必须跨重启可验证（F-01）

### 7.1 问题

武装时的强验证结论只存在银行侧 `VerifyService` 的进程内 `Map` 里
（`packages/bank/src/verify/index.ts`）。窗口到期执行红级节点时，审批服务的
`challenge-required` 分支看的是**本次新签发**的挑战，而窗口代签从未验过它；
同进程还能靠"武装时的挑战仍 `passed()`"兜住，**进程一重启就必然失败**。
实测形态：窗口执行了、计划 `failed`、钱没动（安全但不可兑付）。

### 7.2 决定

`TicketAuthorization` 仍只带 `{kind, ref, digest}`（不改 ADR-0008 的契约面），
预授权凭据走**审批输入的内部字段** `preauth`，由三个条件共同约束：

1. `authorization.kind === 'window'`，且 `preauth.windowId === authorization.ref`；
2. 窗口仍在 `armed`，**本次 run 的唤醒标记在**（planId / digest / challengeId 对齐），
   `planId` / `challengeId` / `channel` / `verifiedAt` / `expiresAt` 与账本逐项一致，
   `nodeId` 必须在这张计划里；
3. 当前时刻落在 `[verifiedAt, expiresAt]`；
4. 应答者必须是窗口代签者本人（`window-responder`）：通用渠道抢答不算数——
   否则预授权会绕过 `WindowSigner` 的世界复验与预算记账。

满足后，强验证的判据按**可用证据**降级，但只降级到"有据可查"为止：

- 有签名回执且部署配置了密钥 ⇒ **只认验签**（失败即拒绝，不退回内存路径）；
- 否则退回同进程 `passed(武装挑战)`；再不行一律 `challenge-required`。

预授权成立时的 `approval/decided.reason` 固定写 **`window-preauth`**，
与"当场验过人"的记录区分；`window-authorized` 仍只是应答者的应答理由，不当作证据。

### 7.3 回执

`receipt = HMAC-SHA256(key, canonicalJson({sessionId, windowId, planId, nodeIds,
challengeId, channel, verifiedAt, expiresAt}))`，写入
`ArmedPlan.challenge.receipt`，随 `plan_arm` 的 `tool/result` 落进会话日志。
密钥来自部署环境（`BAH_WINDOW_RECEIPT_KEY`，≥32 字节），**不进仓**；
没有密钥时回执缺省不签发，启动期留告警，行为退回同进程路径。

回执按 `(windowId, planId, nodeIds)` 绑定：`nodeIds` 是**整张计划的节点集合**，
同一窗口的任意腿共用一张回执；`claim.nodeId` 只做"该节点属于本计划"的存在性检查，
不参与签名（2026-11-23 按实现订正：原文写"按 nodeId 绑定、另一条腿不能复用"，与
`plan.ts` 的签发/验签实现不符）。同一节点在 `resume` 里的重试可以复用
（验证的是"人"，不是"第几次尝试"）。
它不替代 `WindowSigner` 的世界复验（余额 / 条件 / 预算每次重算）。

### 7.4 未覆盖（显式登记）

> **2026-11-23 补记：以下两条已修，原文保留作决策历史。**
> - F-02：`transfer_schedule` / `birthday_plan` 的出参现在是"人话 + 带
>   `<!--bah:window-plan-->` 前缀的 `ArmedPlan` 边车块"；`replayArmedPlans` 同时认
>   边车块与旧版纯 JSON，重启后窗口可重建（`armed.test.ts` 新增两条回归）。
> - F-03：`transfer_schedule` 的计划体不再写手机号，只引用 `name` +（可选）`payeeId`；
>   手机号仍留在本次工具入参与审批明细里。计划体因此不含会被 `redact` 掩码的 PII，
>   `planDigest` 在回放后可复算。带手机号的旧日志仍会 `plan-digest-mismatch`（正确拒绝）。

- `transfer_schedule` / `birthday_plan` 的工具出参是**人话摘要**，
  不含完整 `ArmedPlan`；`replayArmedPlans` 只认 `plan_arm` / `plan_disarm` 的
  结构化出参 ⇒ 这两类窗口本身不跨重启（回执再对也回放不出窗口）。要支持需另立
  持久化方案（标记 JSON 边车或新领域事件），不得在本 ADR 下宣称已支持。
- 会话日志落盘前会做 PII 掩码（`packages/persistence/src/jsonl/redact.ts`）。
  `plan_arm` 出参是 JSON 字符串，手机号会被掩码成 `139****3333`；重启回放后
  `planDigest` 与武装时不一致，`plan-digest-mismatch` 会**正确拒绝**签名。
  也就是说：带手机号的计划目前不能跨重启续跑，修法应是计划里引用 `payeeId`
  而不是原始 PII，而不是放宽摘要校验。
