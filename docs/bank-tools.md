# 银行工具族 bank-tools（施工单 08 落地说明）

> 读者：写审批 / 强验证接线的人（09）、写渠道卡片的人（13–15）、做演示脚本与验收的人。
> 规格权威仍是 `BAH-施工文档集/08-银行工具族.md`；本文只讲**本仓怎么落地**、**接缝在哪**、
> 以及**哪些部分刻意留给后续施工单**。

## 1. 模块图

```text
packages/bank/src/
├─ tools/
│  ├─ specs.ts        30 个银行工具的元数据唯一来源（name / description / schema / tier / 事件）
│  ├─ catalog.ts      createBankTools(deps)：穷尽工厂表 + 目录顺序
│  ├─ render.ts       docs/tool-catalog.md 的渲染（生成器与门禁共用）
│  ├─ dto.ts          结果视图（工具 / 事件 / 卡片三方共用）
│  ├─ events.ts       领域 durable 事件（模块增强 SessionEventMap）
│  ├─ presenters.ts   纯函数卡片（presentCall / presentResult）
│  ├─ tier.ts         三级权限判定（取高不取低；施工单 09 §1 的 08 段）
│  ├─ identity.ts     会话身份（BANK_IDENTITY 服务 + identity/bound 回放恢复）
│  ├─ governance.ts   pre-execute 判决 + approval/request 票据桥接
│  ├─ queries.ts      account_list / account_balance / txn_query / bill_* / analysis_calc
│  ├─ transfers.ts    transfer_preview / transfer_create
│  ├─ wealth.ts       wealth_list / compare / purchase
│  ├─ verification.ts verify_face / sms / ushield
│  ├─ compute.ts      受限表达式求值器（11 的 compute-bounded 的默认替身）
│  ├─ tickets.ts      三字段 TicketRef ↔ 五绑定 TicketRef 的桥接
│  └─ testing.ts      单测夹具（不从包入口导出）
└─ verify/index.ts    强验证挑战 / 锁定状态机 + 可替换 Provider
```

`pnpm tool-catalog` 由 `specs.ts` 生成 [tool-catalog.md](tool-catalog.md)；
门禁 `verify-tool-catalog` 逐字比对（数量上限 31、工厂表与目录穷尽一致、落账事件与只读事件都已声明、
`spec.readEvent` 与 `READ_ONLY_ACTIONS` 双向一致）。

## 2. 30 个银行工具

| 场景 | 工具 | 级别 | 落账事件 |
|---|---|---|---|
| 账户/账单 | `account_list`（含卡片清单） `account_balance` `txn_query` `bill_analyze` `bill_report` `analysis_calc` | 绿 | `read/*` |
| 转账 | `transfer_preview`（绿，只读试算） `transfer_create`（黄，`amountPath: 'amount'`） `aa_create`（黄，动作式：`create` 建组 / `status` 只读查询（绿档豁免）/ `collect` 模拟代收 / `decline` 参与人拒绝 / `close` 提前结束） | 绿 / 黄 / 黄 | `transfer/preview` `transfer/created` `aa/created` `aa/collected` `aa/participant-updated` |
| 理财 | `wealth_list` `wealth_compare`（绿，结果带 `customerRisk`/`eligible`） `wealth_purchase`（红，适当性闸门） `risk_assess`（黄，服务端问卷：`action=questions` 取卷 / `action=submit` 落档） `wealth_positions`（绿，持仓） `wealth_redeem`（红，赎回） | 绿 / 绿 / 红 / 黄 / 绿 / 红 | `read/wealth` `wealth/purchased` `read/risk-questions` `risk/assessed` `read/wealth-positions` `wealth/redeemed` |
| 强验证 | `verify_face` `verify_sms` `verify_ushield` | 绿（渠道，须由红级挑战链调用） | `verify/*` |
| 资产处置 | `card_report_lost`（红，挂失不可逆） | 红 | `card/reported-lost` |
| 卡片状态 | `card_freeze`（黄，可逆） `card_unfreeze`（红） `card_apply`（黄，申请新卡；`kind='credit'` 时给授信额度） `card_limit_set`（红，调额/调授信额度） `card_restriction`（黄，交易限制 set/clear） | 黄 / 红 / 黄 / 红 / 黄 | `card/state-changed` `card/issued` `card/limits-changed` `card/restrictions-changed` |
| 订阅/代扣 | `sub_list`（绿，检测只读） `sub_cancel`（黄，合约期硬拦/到期即断） `sub_watch`（黄，提醒与标注） `sub_authorize`（黄，只关不开） | 绿 / 黄 | `read/subscriptions` `sub/cancelled` `sub/watch-updated` `sub/authorization-revoked` |

完整参数 schema 与「何时用 / 何时不用」见 [tool-catalog.md](tool-catalog.md)。
`tier` **只在 `specs.ts` 声明**，`execute()` 里没有任何权限阈值（`verify-tiers` 门禁 + 评审双保险）。

**金额口径**：模型参数是「元」，核心与事件是「分」（字段名带 `Cents`）。
工具边界用 `yuanToCents()` 转一次；展示统一 `formatYuan()`（不依赖 locale）。

**`viaCardId` 语义**（`transfer_preview` / `transfer_create` / 宿主内部 `merchant_order` 的可选参数）：
传了 = 以该卡支付。以卡转账会同时判定卡状态、online/overseas 限制与**同卡近 30 天月限额**；
`merchant_order` 传了就经 `bank:card-spend` 窄端口**先扣款再下单**（扣款失败不落订单）。
不传 = 账户转账 / 纯商户下单，行为与改动前逐字相同。这不是真实产品语义，是我们为让卡状态与
限额可验证补的最小通道。

**卡消费通道（mock）**：`bank-core.spendOnCard` 的校验顺序固定——卡存在且归属 →
状态 `normal` → `online` 限制 → `category` 限制 → **授信额度（仅 `kind='credit'`，ADR-0015）** →
日/月限额 → 账户可用余额 → 记账（`consumption/out` + `viaCardId`）。宿主只经 `bank:card-spend` 窄端口暴露给内部工具
`merchant_order(viaCardId)`；**模型不能直接调用**。这是 mock 收单，**不是真实收单**：
真实商户 API / 行内清算不在本仓。

**授信额度 vs 交易限额**（ADR-0015）：两者是不同语义的约束，**不要**互相冒充——
授信额度是信用卡的**天花板**（`creditLimitCents` / `usedCreditCents`，只在 `kind='credit'` 的卡上有），
交易限额（`dailyLimitCents` / `monthlyLimitCents`）是叠加在上面的"防单日/近 30 天大额"。
`spendOnCard` **先判授信额度再判日/月限额**，为的是让拒绝理由对得上事实（借记卡不进这条分支，
判定顺序逐字不变）。失败都在记账之前抛出：**没扣钱就不占额度**；成功才 `usedCreditCents += amount`。
信用卡的日/月限额**缺省 = 授信额度**（总额度已经封顶，再套一个更小的日限额会让"额度内可用却刷不出去"）。

卡片状态机图：[docs/diagrams/card-state-machine.png](diagrams/card-state-machine.png)（`normal ⇄ frozen` 黄/红，`→ lost` 红）。

## 3. 三级权限与票据链（08 落地、09 收口）

```text
模型调用
  │ tool/call 落账（含声明 tier）
  ▼
tools/pre-execute（waterfall）
  ├─ 身份：`BANK_IDENTITY` 无绑定 → deny no-identity
  ├─ transfer_create：bank-core previewTransfer →
  │    当日累计含本笔 > min(账本日限额, Config dailyTransferLimit) → 红（daily-limit）
  │    收款人 binding = new     → 红（new-payee）
  │    余额不足等 block 级风险   → deny（不进入审批）
  ├─ 同 turn 风险调用超 riskyCallThreshold → 非绿一律 ask（risky-calls）
  ├─ 强验证锁定中且红 → deny verify-locked
  ├─ 绿 → allow（交还下游判决）
  ├─ 黄 → ask + TicketDraft（ttl 来自 config）
  ├─ 红 → ask + challenge（sms / face / ushield，来自 config）
  └─ 每次判决落 tier/decided（级别 + 理由 + 判决 + 理由码）
  ▼
approval/request（waterfall）
  ├─ 签发 bank-core 五绑定票据（会话 / 工具 / 参数指纹 / 金额 / TTL）+ ticket/issued
  ├─ @bah/interaction 的仲裁器决定 allowed-once / rejected / cancelled / unavailable
  └─ 同步 issued → approved / blocked + ticket/approved | ticket/blocked
  ▼
tools/execute → 工具体
  └─ 工具边界组装 TicketRef → bank-core redeem()（唯一核销属主）
  ▼
tools/result → ticket/redeemed + ticket/consumed（成功）或 ticket/blocked（失败）
```

**判定是"取高不取低"**：声明级别是下限；金额 / 收款人 / 组合风险只能上调，重试 / 超时 /
渠道切换都不降级。日累计的**权威口径在 bank-core 账本**，runtime 侧只是缓存（换会话不重置）。
阈值只来自 `bank:tools` 配置（`dailyTransferLimit` / `riskyOps` / `riskyCallThreshold`），
模型输出与用户口头声明不参与判定。
指纹由 `fingerprintOf(tool, args)`（键序无关）重算，审批后改参数会在
`TicketStore.redeem()` 处被拒（`ticket-binding-mismatch`），不是靠工具自觉。

### 3.1 可替换的策略引擎（W04）

判定矩阵的**接口**在 `packages/runtime/src/policy/index.ts`（`PolicyEngine` +
`POLICY_ENGINE` 服务键），**默认实现**在 `packages/bank/src/tools/policy.ts`
（`createTierPolicy`，直接调用 `tier.ts` 的 `decide()`，不复制规则）。

装配优先级：`provideBankGovernance({ policy })` > 宿主注入的 `runtime:policy` >
`createTierPolicy`。宿主 `bank:tools` 在 apply 时 `findPolicyEngine(ctx)`，有就传下去。

组合规则是**取严不取宽**：

| 策略意见 | 对黄/红工具的效果 | 对绿级工具 |
|---|---|---|
| `deny` | 拒（`code = policy-denied`，不签票据） | 不咨询策略，照常放行 |
| `ask` | 不额外加码（黄/红本来就要审批） | 不咨询 |
| `allow` | **不能**把黄/红降成免审批 | — |

> 绿级不咨询策略是刻意的：读操作不该被写策略误伤（TC-W04-06）。
> 策略若想拒绝读操作，属于新的需求，必须改接口语义并出 ADR。

### 09 的落地情况

| 能力 | 落点 |
|---|---|
| `decide()` 判定矩阵 | `tools/tier.ts`（矩阵 + 五条附加规则）；入口在 `governance.ts` |
| 审批服务 | `@bah/interaction` 的 `ApprovalService`（应答者 / 超时 / 双渠道竞答 / 归一化） |
| 票据生命周期 | `@bah/interaction` 的 `TicketLedger`（`ticket/*` 事件）；核销仍属 bank-core |
| 会话身份绑定 | `bank:identity` + `@bah/persistence` 的 credentials（mock 短信 / IM 映射 / Web 接缝） |
| 强验证挑战链 | 红级 `ask+challenge` → `bank:challenge` 端口签发 → 验证通过才批准 |

## 4. 身份与配置

### 4.1 会话身份（08 已并入）

`bank:tools` 启动时：

1. 建 `SessionIdentityStore`，注册服务键 `bank:identity`（`BANK_IDENTITY`）；
2. 从本会话日志恢复 `identity/bound`（回放 / 重启后身份不丢）；
3. 若 profile 显式写了 `demoUserId` 且当前绑定不同，则 `bind()` + 落一条 `identity/bound`
   （`method: 'demo-config'`）。

09 的 credentials 走同一条绑定路径（事件名不变）：

```ts
// @bah/persistence 的 CredentialsService 内部（三个渠道统一）
identity.bind(sessionId, userId)
session.append('identity/bound', { userId, method: 'mock-login', at: now }, { ignorable: true })
```

**绝不隐式使用默认账户**：不写 `demoUserId`、也没有 `identity/bound` 的会话，任何业务工具在
`pre-execute` 统一 deny `no-identity`（工具内的 `requireUserId` 是第二道兜底）。

`bank:tools` 的配置（`profiles/headless/patch.yml` 示例）：

```yaml
- id: bank:tools
  config:
    demoUserId: u-1          # 显式演示引导；不写 = 未绑定（业务工具全 deny）
    seed: 7                  # 造数种子（与快照 randomSeed 同源）
    datasetTier: demo        # demo / stress / adversarial
    disclaimerId: wealth-risk-v1
    ticketTtlSeconds: 120    # 票据 TTL = 审批超时（同源，施工单 09 §10）
    computeTimeoutMs: 5000
    redChallenge: sms
    dailyTransferLimit: 5000 # 元；生效值 = min(账本日限额, 本值)
    riskyOps: [transfer_create, wealth_purchase]  # 组合风险计数对象
    riskyCallThreshold: 3    # 同 turn 风险调用上限；超过后非绿一律 ask
    riskCooldownDays: 1      # 风险测评重测冷却（天）；0 = 关闭（演示档）
    verify: { provider: gateway, successAfter: 1, maxAttempts: 3, lockMinutes: 30 }
    ticketLease: { enforce: true, ttlSeconds: 120 }  # W12；缺省 = ticketTtlSeconds
```

W09：`verify.provider=gateway`（默认）是**测试网关适配器**，接口与 mock 一致但保留
`VerifyGatewayClient` 注入点；`mock` 是回滚开关。失败计数/锁定仍在 `VerifyService` 内存，
**重启丢失**；未接真实短信/人脸/U 盾供应商。

W12：`ticketLease.ttlSeconds` 是票据 TTL 内的**执行 lease** 窗口，缺省等于 `ticketTtlSeconds`
（行为与 W12 之前等价）；`ttlSeconds > ticketTtlSeconds` 启动即 `invalid-config`；
`enforce: false` 回滚到"只用票据 TTL"。lease 到期时刻会写进 bank-core 五绑定的 `expiresAt`，
过期后核销直接 `ticket-expired`，不产生转账。`bank:tools` 同时提供 `bank:compensation`
窄端口（`reverse` / `reversalOf`），供 `bank:saga-bridge` 的补偿通道调用。

| 键 | 默认 | 说明 |
|---|---|---|
| `ticketLease.enforce` | `true` | `false` = 回滚到只用票据 TTL（W12 的第一刀） |
| `ticketLease.ttlSeconds` | `ticketTtlSeconds` | lease 窗口；必须 ≤ 票据 TTL，否则启动即 `invalid-config` |

R-2（2026-11-01）：`riskCooldownDays` 是风险测评的**重测冷却**（天，缺省 1，`0` = 关闭）。
同一用户 `risk_assess(action="submit")` 落档成功后进入冷却；窗口内再提交返回
`risk-retest-cooldown`（工具层翻译成「距上次测评不足 N 小时，请在 M 小时后重试」），
且**不核销新卷**；冷却结束且问卷未过 15 分钟 TTL 时，同一张卷仍可提交。
判定与状态都在核心（`lastAssessedAt` 只在落档成功时写，失败不启动冷却）；
状态是进程内 Map，重启清零（自评 R-22）。

账户归属在工具边界复核：`bankCore.balance(accountId)` 本身不校验用户，
工具先用 `listAccounts(userId)` 过滤，越权返回 `account-forbidden`（不泄露账户存在性）。

## 5. 卡片契约（给 13–15）

presenter 是**纯函数**：同输入同输出；不访问 ctx / 时间 / 随机；坏参数退化为「待定」而不是抛错。
卡片由事件数据派生：领域事件的 `result` 就是 `presentResult` 的输入。

| `kind` | 触发 | 关键字段 |
|---|---|---|
| `bank.account-list` | `account_list` | `accounts[].tail/typeLabel/balanceText`；`cards[].tail/typeLabel/statusLabel/limitText` + 信用产品的 `creditText`（`额度 / 已用 / 可用`，ADR-0015） |
| `bank.balance` | `account_balance` | `balanceText/availableText/frozenText/txnRef` |
| `bank.txn-list` | `txn_query` | `items[].atText/amountText/counterparty` |
| `bank.bill-analysis` | `bill_analyze` | `categories[].shareText/anomalies/momText`；`merchantCategories[]`（`groupBy=merchant` 时的品类文案） |
| `bank.bill-report` | `bill_report` | `text`（`collapsed: true`） |
| `bank.analysis` | `analysis_calc` | `code/valueText/operations` |
| `bank.transfer-preview` | `transfer_preview` | `amountText/payeeName/remainingText/risks/tier` |
| `bank.transfer-confirm` | `transfer_create.presentCall` | `operation/amountText/payeeName/tier/requiresApproval` |
| `bank.transfer-created` | `transfer_create` 成功 | `txnId/ticketId/atText` |
| `bank.wealth-list` / `-compare` | `wealth_list` / `wealth_compare` | `products/disclaimerId`（必渲染风险提示）；`customerRisk` + 每项 `eligible/suitabilityNote` |
| `bank.wealth-confirm` | `wealth_purchase.presentCall` | `tier: red/requiresApproval` |
| `bank.wealth-purchased` | `wealth_purchase` 成功 | `holdingId/disclaimerId`；`riskMatch`（`customerRisk/productRisk`） |
| `bank.verify` | `verify_face` / `verify_sms` / `verify_ushield` | `channelLabel/success/remainingAttempts/lockedUntilText` |
| `bank.card-state` | `card_freeze` / `card_unfreeze` | `cardId/tail/status/statusLabel/changed` |

三态：待执行 = `presentCall`；完成 = `presentResult`；被拒 = `tool/result` 的 `code`（不伪造卡片）。
审批卡片必含的六项都在 `bank.transfer-confirm` / `bank.wealth-confirm` 里：操作类型、金额、收款人/产品、
风险等级、票据 TTL（`ticketTtlText`）、拒绝理由输入框标记（`rejectReasonRequired`）；09 的审批服务只负责
实际收集理由并落 `approval/decided`。

## 6. 领域事件

| 事件 | 载荷 | 说明 |
|---|---|---|
| `identity/bound` | `{ userId, method, at }` | 会话绑定银行用户；回放时据此恢复 |
| `tier/decided` | `{ callId, name, level, reason, verdict, code?, at }` | 每次 pre-execute 判决的审计落点 |
| `read/accounts` `read/balance` `read/txns` `read/bill-analyzed` `read/bill-report` `read/analysis` | `{ result }` | 结果整块落账，卡片可重建 |
| `read/wealth` | `{ op: 'list' \| 'compare', result }` | 带 `disclaimerId` |
| `transfer/preview` `transfer/created` `wealth/purchased` | `{ result }` | 写操作只在成功时落 |
| `verify/face` `verify/sms` `verify/ushield` | `{ result }` | 每次尝试都落 |
| `verify/locked` | `{ sessionId, channel, until, attempts }` | 连续失败触发的会话级锁定 |
| `card/reported-lost` | `{ cardId, tail, status: 'lost', at }` | 挂失（ADR-0003，不可逆） |
| `card/state-changed` | `{ cardId, tail, from, to, reason, note?, at }` | 冻结/解冻（ADR-0006；幂等调用不发射） |
| `card/issued` | `{ cardId, accountId, tail, type, limits, creditLimitCents?, at }` | 新卡申请（`creditLimitCents` 仅信用产品，ADR-0015 / 事件表 §3.5） |
| `card/limits-changed` | `{ cardId, tail, from, to, creditLimitCents?, usedCreditCents?, at }` | 额度调整（信用产品多两个可选字段：变更后的授信与**变更时**的已用） |
| `card/restrictions-changed` | `{ cardId, tail, mode, restrictions, at }` | 交易限制设置/解除 |
| `card/spent` | `{ cardId, tail, txnId, merchantCategory, amountCents, at }` | 卡消费已记账（ADR-0012；mock 收单，不是真实收单） |
| `aa/created` | `{ result }` | AA 收款请求创建 |
| `read/aa` | `{ result }` | AA 收款请求读取（`action=status`，绿档豁免） |
| `aa/collected` | `{ groupId, participantIndex, collectedCents, txnId, at }` | AA 模拟代收（ADR-0011；demo 口径，不是真实到账） |
| `aa/participant-updated` | `{ groupId, participantIndex, from: 'pending', to: 'declined' \| 'expired', at }` | 参与人拒绝 / 到期（ADR-0017；不放姓名） |
| `risk/assessed` | `{ result }` | 风险测评并更新客户等级 |
| `read/wealth-positions` | `{ result }` | 持仓读取 |
| `wealth/redeemed` | `{ result }` | 理财赎回成功 |
| `sub/cancelled` | `{ subscriptionId, merchant, at }` | 取消订阅 |
| `proactive/reminder` | `{ source, key, title, channel, suppressedReason?, at }` | 主动提醒已投递/被预算压掉（ADR-0016；**非工具**插件经 `bank:audit` 落账，`channel='none'` 必带 `suppressedReason`） |

审批与票据生命周期事件（`ticket/*`、`approval/duplicate|timeout|challenge-*`）由
`@bah/interaction` 声明，见 [interaction.md](interaction.md) §5。

**为什么都带 `ignorable: true`**：运行时的 `deriveMessages` 只认识平台族事件；
领域事件若按 required-on-read 落账，下一条请求装配会拒绝（`session-unknown-event`）。
`ignorable` 表示"旧 reader 可跳过"，UI 仍可从原始日志读取。
`verify-session-events` 门禁已扩展为读取 `BankSessionEventMap` 的模块增强。

## 7. 受限计算（`analysis_calc`）

默认实现是**确定性表达式求值器**，不是 `eval`：

- 数字、`+ - * / %`、括号、一元正负；
- `data.foo` / `data['foo-bar']` 只读数据引用；
- `sum / avg / min / max / round / abs`；
- 预算：10,000 次运算 + 墙钟超时（`compute-timeout`），工具层再用 `Promise.race` 兜一层；
- 取消：`ToolExecContext.signal` → `compute-aborted`。

接缝 `BankToolDeps.compute` 可整体替换；11 的真实 `compute-bounded` 沙箱接进来即可，
工具代码不需要改。**代码永不进 `none` 档**。

## 8. 测试与验收

| ID | 用例 | 落点 |
|---|---|---|
| T-TOOLS-001 | 绿级直行（无审批） | `tools/governance.test.ts` + `host/.../bank-tools.test.ts` |
| T-TOOLS-002 | 黄级 800 元白名单 → ask + 票据 | `tools/governance.test.ts` |
| T-TOOLS-003 | 日累计升红（6,000 元） | `tools/governance.test.ts` + `tools/tier.test.ts` |
| T-TOOLS-004 | 新收款人升红（100 元） | 同上 |
| T-TOOLS-005 | `wealth.*` 带 `disclaimerId` | `tools/wealth.test.ts` |
| T-TOOLS-006 | 受限计算超时结构化失败 | `tools/queries.test.ts` |
| T-TOOLS-007 | 独立 verify → `no-challenge` | `tools/verification.test.ts` |
| T-TOOLS-008 | 三连败 → 锁 30 分钟 + `verify/locked`（09 编号 T-VER-002） | 同上 |
| T-TOOLS-009 | presenter 纯度 | `tools/catalog.test.ts` |
| T-TOOLS-010 | 目录与源码一致（篡改即红） | `tools/catalog.test.ts` + `pnpm gate` |

09 的判定用例（T-TIER-001~010）落在 `tools/tier.test.ts` / `tools/accumulation.test.ts` /
`tools/governance.test.ts`；审批用例见 [interaction.md](interaction.md) §9。

headless 实跑（幕 3：800 元黄级全流程）：

```bash
pnpm bah --profile headless --prompt "给王建国转800元" --session s-tier09 --jsonl .tmp-tier09
# 29 条事件：identity/bound → tool/call → tier/decided → approval/asked → ticket/issued
#   → ticket/approved → approval/decided → transfer/created → ticket/redeemed
#   → ticket/consumed → tool/result → 文本收尾
```

## 9. headless 演示脚本片段

`core:model` 的 mock 脚本可以按顺序驱动多个工具。当前 `profiles/headless/patch.yml` 的默认脚本
是**幕 3**（`transfer_create` 800 元 + `interaction:approval` 的 headless 自动应答者）；下面是
只读工具的脚本示例（历史 08 演示）：

```yaml
- id: core:model
  config:
    provider: mock
    script:
      - tool: { id: c1, name: account_list, args: {} }
      - tool: { id: c2, name: account_balance, args: {} }
      - tool: { id: c3, name: txn_query, args: { direction: out, limit: 5 } }
      - tool: { id: c4, name: bill_analyze, args: { period: month } }
      - tool: { id: c5, name: bill_report, args: { period: month, format: detail } }
      - tool: { id: c6, name: wealth_list, args: {} }
      - tool: { id: c7, name: wealth_compare, args: { ids: [w-1, w-2] } }
      - tool: { id: c8, name: analysis_calc, args: { code: 'data.a / data.b * 100', data: { a: 1, b: 4 } } }
      - tool: { id: c9, name: transfer_preview, args: { amount: 800, payee: { name: 王建国, phone: '13900002222' } } }
      - text: 演示完成。
```

写操作（`transfer_create` / `wealth_purchase`）需要审批应答者（`interaction:approval` 的
`responder: headless`，或渠道 UI）；强验证（`verify_face` / `verify_sms` / `verify_ushield`）
需要红级挑战链签发的挑战 ID——审批链里的验证由 `bank:challenge` 端口自动完成。

## 10. 已知边界

| 项 | 现状 | 计划 |
|---|---|---|
| 红级强验证串联 | 已由 09 串联：`ask+challenge` → `bank:challenge` 签发 → 验证通过才批准 | — |
| 日限额与执行 | 升红后经批准仍会执行（bank-core 不拦日限额；规格把日限额放在权限升级） | 若产品要"拒绝"，改判定 `deny` 并同步 T-TIER-004 |
| card / subscription | `card` 的 list / reportLost / freeze / unfreeze / apply / limit / restriction 已接（`account_list` 带出卡片清单）；`subscription` 的 list/cancel/watch/authorize 已接 | — |
| 定时转账 / AA 拆分 | 定时转账由宿主工具 `transfer_schedule` 复用 `plan_arm`+`plan_wake`（plan-enabled profile），签票时带金额/脱敏收款人/执行时刻明细（§11）；AA 由 `aa_create` 生成份额与待收状态，`collect` 是**模拟代收**（本进程替参与人把份额记进组织者主账户并写 `in/transfer` 流水），跨人真实到账不存在；`decline` / `close` / 到期 job 只改参与人状态并落 `aa/participant-updated`，不动钱。`collect` 在记账前与到期 job 同判 `expiresAt < now`，过期即 `aa-group-closed`；组完成后对已 `paid` 的人重复代收与 collecting 分支同码 `aa-participant-paid`（ADR-0017 §2.5） | 真实到账仍走账户入账；`collect` 不是第三方付款证明；`paid` 只表示本进程记了账；AA 写动作的票据核销账本暂未与工具体闭环（ADR-0017 §2.8 登记为例外） |
| 生日定时 / 商户腿 | 宿主工具 `birthday_plan` 生成三张授权窗口（锁预算/鲜花/蛋糕），共享 `parentPlanId` 与父预算（ADR-0013）；商户腿**先预占后付款**：缺货/超时在预占失败（未扣款），预占价 ≠ 用户批准价 ⇒ `price-changed` 跳过；扣款后 `commit` 失败 ⇒ 冲正该腿银行流水（entry 带 `compensation`），Web/移动计划卡显示「已冲正」；审批卡逐笔显示金额与商户（报价为准，§11） | 真实商户 API/退款接口、整图（非逐腿）补偿仍是缺口；父预算守卫在现有算术下先验不可达（纯函数单测钉边界） |
| 卡额度 / 交易限制 | `card_limit_set` 的日/月限额都参与判定：日限额取 min(卡日限额, Config 日限额)；月限额按**同卡近 30 天滚动窗口**（转出 + 消费，冲正回退）硬阻断，不是自然月。`card_restriction` 的 online/overseas 对以卡转账硬阻断；category 只在 mock 卡消费通道（`merchant_order(viaCardId)`）拦截 | 真实收单/清算、跨卡合并额度、自然月账单口径仍不做 |
| 授信额度（信用卡） | `Card.kind='credit'` 时 `card_apply` 必给额度、`card_limit_set` 可调额度（降额不得低于已用 → `credit-in-use`）；`spendOnCard` 超额度抛 `credit-limit-exceeded`，**失败不占用、成功才占用**（ADR-0015）；`account_list` 回读额度/已用/可用 | **还款、账单周期、最低还款、分期不做**；信用卡仍从绑定账户扣款（不是真实透支）；冲正不释放已用额度；授信额度不约束以卡转账 |
| 单应用单会话 | 票据五绑定里的 `sessionId` 来自 `bah:run`（一应用一会话） | 与 R52 一并评估多会话 |
| 风险测评问卷 | 5 题固定 × 3 选项（分值 1/3/5），题干与分值**只**在服务端常量表（`core/risk-questionnaire.ts`）；模型只能搬运 `{index,key}`，不持有卷 ID 就落不了档。问卷 15 分钟有效、一次性核销、跨用户按"不存在"拒绝（防枚举）；`action="questions"` 经 `tier.ts` 的 `READ_ONLY_ACTIONS` 豁免（不签票、不改等级、审计记 `green/declared`）；落档后进入重测冷却（`bank:tools.riskCooldownDays` 缺省 1 天，0 关闭；冷却拒绝不核销新卷） | **非监管全卷**；冷却只是节流且状态在进程内（重启清零，R-22）；IM 为一次成型作答（无逐题状态机） |
| 审批应答者 | headless 有显式自动应答者；Web / IM 渠道属 13/15 | 渠道只需 `attach(responder)` |

## 11. 宿主侧工具的审批明细与 `detailsDigest`（G8）

`plan_arm` / `transfer_schedule` / `birthday_plan` 不在银行工具目录里（它们是宿主工具，
`packages/host/src/boot/plugins/plan.ts`），但它们**动钱**，所以签票时必须把每一笔钱说清楚。

### 11.1 明细从哪来

| 工具 | 明细来源 | 关键纪律 |
|---|---|---|
| `plan_arm` | 计划本体：`title` / `budgetCents` / `dueAt` / `tier` / `conditions` / `merchant.offerId` / `plan.nodes` | 商户报价取自 `bank:merchant.offer(offerId)`（**只读**，不走 `search` 以免把没搜过的 offer 变成可下单） |
| `transfer_schedule` | 入参的确定性字段：`amount` / `payee.name` / `payee.phone`（脱敏） / `when` | 手机号只出现 `139****2222` 形态；「当日已用/剩余」**整条省略**——core 没有当日累计支出这个面，不拿可用余额冒充 |
| `birthday_plan` | 三腿：锁定预算（`lockPayee`）+ 鲜花 + 蛋糕 | 鲜花/蛋糕金额**只认 `offer.priceCents`**，入参 `flowerYuan` / `cakeYuan` 不是报价（两者可能不同，用户付的是报价） |

渲染器在 `packages/host/src/boot/plugins/plan-details.ts`（纯函数，不读时钟/随机/ctx）：
行序固定为「金额 → 商户 → 每条腿 → 到期 → 条件快照 → 档位」，**顺序即契约**。

### 11.2 `detailsDigest` 口径

- 算法：`sha256(canonicalJson(details)).slice(0, 16)`（16 位十六进制 = 64 bit；防的是"悄悄换掉明细"，不是抗碰撞）。
- 落点：`ArmedPlan.detailsDigest`（`packages/runtime/src/authorization/types.ts`），随 `plan_arm` 的
  `tool/result` 出参落账；重启后 `replayArmedPlans` 从同一份 JSON 重建。
- 复验：`plan_wake` 在 `checkWindow` 通过之后、预算校验之前**重算**一次；不一致 →
  `status:'downgraded'` / `code:'details-changed'` / `failed:[{kind:'details-digest'}]`，
  **降级为人工确认，不自动放行**。
- 无 `detailsDigest` 的旧窗口（本版本之前的回放数据）不拦：那是"没有背书"，不是"背书被改"。
- 涨价也算"被改"：`bank:merchant.fault: price-up`（+30%）会让摘要变化 → 唤醒降级，
  这正是「不擅自加价」在唤醒期的落地。
