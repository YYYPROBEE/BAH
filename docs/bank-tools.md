# 银行工具族 bank-tools（施工单 08 落地说明）

> 读者：写审批 / 强验证接线的人（09）、写渠道卡片的人（13–15）、做演示脚本与验收的人。
> 规格权威仍是 `BAH-施工文档集/08-银行工具族.md`；本文只讲**本仓怎么落地**、**接缝在哪**、
> 以及**哪些部分刻意留给后续施工单**。

## 1. 模块图

```text
packages/bank/src/
├─ tools/
│  ├─ specs.ts        14 个 P0 工具的元数据唯一来源（name / description / schema / tier / 事件）
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
门禁 `verify-tool-catalog` 逐字比对（数量上限 28、工厂表与目录穷尽一致、事件已声明）。

## 2. 14 个 P0 工具

| 场景 | 工具 | 级别 | 落账事件 |
|---|---|---|---|
| 账户/账单 | `account_list` `account_balance` `txn_query` `bill_analyze` `bill_report` `analysis_calc` | 绿 | `read/*` |
| 转账 | `transfer_preview`（绿，只读试算） `transfer_create`（黄，`amountPath: 'amount'`） | 绿 / 黄 | `transfer/preview` `transfer/created` |
| 理财 | `wealth_list` `wealth_compare`（绿） `wealth_purchase`（红） | 绿 / 绿 / 红 | `read/wealth` `wealth/purchased` |
| 强验证 | `verify_face` `verify_sms` `verify_ushield` | 绿（渠道，须由红级挑战链调用） | `verify/*` |

完整参数 schema 与「何时用 / 何时不用」见 [tool-catalog.md](tool-catalog.md)。
`tier` **只在 `specs.ts` 声明**，`execute()` 里没有任何权限阈值（`verify-tiers` 门禁 + 评审双保险）。

**金额口径**：模型参数是「元」，核心与事件是「分」（字段名带 `Cents`）。
工具边界用 `yuanToCents()` 转一次；展示统一 `formatYuan()`（不依赖 locale）。

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

账户归属在工具边界复核：`bankCore.balance(accountId)` 本身不校验用户，
工具先用 `listAccounts(userId)` 过滤，越权返回 `account-forbidden`（不泄露账户存在性）。

## 5. 卡片契约（给 13–15）

presenter 是**纯函数**：同输入同输出；不访问 ctx / 时间 / 随机；坏参数退化为「待定」而不是抛错。
卡片由事件数据派生：领域事件的 `result` 就是 `presentResult` 的输入。

| `kind` | 触发 | 关键字段 |
|---|---|---|
| `bank.account-list` | `account_list` | `accounts[].tail/typeLabel/balanceText` |
| `bank.balance` | `account_balance` | `balanceText/availableText/frozenText/txnRef` |
| `bank.txn-list` | `txn_query` | `items[].atText/amountText/counterparty` |
| `bank.bill-analysis` | `bill_analyze` | `categories[].shareText/anomalies/momText` |
| `bank.bill-report` | `bill_report` | `text`（`collapsed: true`） |
| `bank.analysis` | `analysis_calc` | `code/valueText/operations` |
| `bank.transfer-preview` | `transfer_preview` | `amountText/payeeName/remainingText/risks/tier` |
| `bank.transfer-confirm` | `transfer_create.presentCall` | `operation/amountText/payeeName/tier/requiresApproval` |
| `bank.transfer-created` | `transfer_create` 成功 | `txnId/ticketId/atText` |
| `bank.wealth-list` / `-compare` | `wealth_list` / `wealth_compare` | `products/disclaimerId`（必渲染风险提示） |
| `bank.wealth-confirm` | `wealth_purchase.presentCall` | `tier: red/requiresApproval` |
| `bank.wealth-purchased` | `wealth_purchase` 成功 | `holdingId/disclaimerId` |
| `bank.verify` | `verify_face` / `verify_sms` / `verify_ushield` | `channelLabel/success/remainingAttempts/lockedUntilText` |

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
| card / subscription | `card` 的 list / reportLost 已接（`account_list` 带出卡片清单）；申请/提额/限额未加；`subscription` 只有 cancel | P1 工具时补齐 |
| 定时转账 / AA 拆分 | `transfer_create` 的 `when` 只支持 `now`，未来时间返回 `unsupported-schedule` | P1 `transfer_schedule` / `transfer_split` |
| 单应用单会话 | 票据五绑定里的 `sessionId` 来自 `bah:run`（一应用一会话） | 与 R52 一并评估多会话 |
| 审批应答者 | headless 有显式自动应答者；Web / IM 渠道属 13/15 | 渠道只需 `attach(responder)` |
