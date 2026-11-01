# 仿真银行 bank

> 读者：写银行工具族的人、做审批票据的人、写渠道 / 演示脚本的人。
> 本文只讲**本仓怎么落地**、**金额与时序口径**，以及**留给后续的桥接点**。

## 1. 模块图

```text
packages/bank/src/
├─ core/
│  ├─ model.ts      九实体 + 品牌 ID（bankIds 铸造点）+ 金额换算 + BankLimits
│  ├─ provider.ts   BankCoreProvider 接口与请求/响应类型（纯类型，零可执行行）
│  ├─ ticket.ts     TicketStore：issued → approved → redeemed | blocked（核销唯一属主）
│  ├─ mock.ts       MockBankCore：内存账本、预检、转账/理财、日累计推导
│  └─ time.ts       UTC 日 / 账期口径（dayKey / monthKey / periodRange）
├─ forge/
│  ├─ index.ts      buildBankDataset：demo / stress / adversarial / recurring 四档造数
│  └─ risk.ts       风控预检六规则 + 夜间时段判定
├─ tools/           银行工具族（见 docs/bank-tools.md）
└─ verify/          强验证挑战 / 锁定（§6 的 Provider seam）
```

## 2. 九实体与金额口径

| 实体 | 关键字段（本仓命名） |
|---|---|
| `User` | `id` / `name` / `phone` / `riskGrade`（R1–R5）/ `verified` / `strongAuth` |
| `Account` | `type`（current / fixed / locked）/ `balanceCents` / `availableCents` / `status` |
| `Card` | `tail`（只存尾号）/ `type` / `status` / `dailyLimitCents` / `monthlyLimitCents`（月限额按同卡近 30 天滚动窗口判定） |
| `Transaction` | `at` / `amountCents` / `direction` / `counterparty` / `category` / `channel` / `status` / `viaCardId?`（以卡支付的卡归属；冲正继承） |
| `Bill` | `period`（`YYYY-MM`）/ 分类汇总 / `anomalies` |
| `WealthProduct` | `kind` / `termDays` / `expectedYieldPct` / `riskGrade` / `minAmountCents` |
| `Holding` | `productId` / `shares` / `costCents` / `marketValueCents` / `profitCents` |
| `Subscription` | `merchant` / `cycle` / `nextChargeAt` / `amountCents` / `status` |
| `Payee` | `name` / `phone` / `binding`（whitelist / new）/ `firstSeenAt` |

**金额一律整数「分」**，字段名统一带 `Cents`。理由：余额、日累计、票据绑定金额会在演示里反复相加，
浮点误差会让"剩余额度"对不上账。模型参数里的「元」只在工具边界用 `yuanToCents()` 转一次；
展示用 `formatYuan()`（`¥12,345.67`，不依赖 locale）。

**ID 一律品牌类型**（`UserId` / `AccountId` / `CardId` / `TxnId` / `PayeeId` / `ProductId` /
`HoldingId` / `SubscriptionId`），与 `@bah/core` 的 `SessionId` / `TicketId` 同构。
唯一允许由字面量铸造的地方是造数与夹具（`bankIds.*`）。

## 3. 票据状态机与核销（本包最重要的机制）

```text
issued(pending) ──批准──▶ approved(allowed-once) ──bank-core 执行──▶ redeemed(consumed)
     │                          │
     └──── 拒绝/超时/失败 ───────┴──▶ blocked
```

| 规则 | 落点 |
|---|---|
| 签发 | 治理平面的 `ask` 判决调用 `TicketStore.issue()`（接线） |
| 批准 | `approve()`：幂等；过期会先置 `blocked(expired)` 再抛 |
| **核销属主** | `redeem()`：同步 CAS；检查与转移之间**没有 await**，JS 单线程内原子 |
| 五绑定 | 会话 / 工具 / 参数指纹 / 金额 / TTL；逐项比对，任何一项不同都拒绝 |
| 失败不消耗 | 除"过期"会顺带置 `blocked`，其余拒绝都不改票据状态 |
| 记账与状态分离 | `tools/result` 侧只落 `approval/decided` 生命周期，不改票据状态 |

错误码（全部 `BahError`，kebab-case）：

| code | 触发 |
|---|---|
| `ticket-duplicate` | 同一票据 ID 重复签发 |
| `ticket-unknown` | 票据不存在 |
| `ticket-expired` | 签发 / 批准 / 核销时已过 TTL（核销与批准会顺手置 `blocked`） |
| `ticket-not-approved` | `issued` 状态直接核销 |
| `ticket-already-redeemed` | 重放（第二次核销） |
| `ticket-blocked` | 已阻断的票据再核销 |
| `ticket-binding-mismatch` | 五绑定不一致（`detail.field` 指出是哪一项） |
| `ticket-closed` | 已核销的票据再批准 / 再阻断 |

## 4. Provider seam

`BankCoreProvider`（`core/provider.ts`）是工具族与渠道唯一依赖的接口：

```ts
listAccounts(userId) / balance(accountId) / queryTransactions(q) / analyzeBill(q) / listWealthProducts(f)
previewTransfer(req)                 // 试算 + 风控预检（只读）
createTransfer(req, ticket)          // 写；票核销在这里
purchaseWealth(req, ticket)          // 写；同上
limits()                             // 风控阈值只读视图
```

- **写操作全部强制 `TicketRef`**：授权进领域边界，模型绕过工具直连核心也拿不到 approved 票据；
- 校验顺序固定：账户存在/状态 → 金额 → 收款人 → 余额 → **核销** → 账本变更（核销后不再抛错）；
- `previewTransfer` 返回 `dailyUsedCents` / `dailyLimitCents` / `remainingCents`（**不含本笔**）、
  `risks[]` 与 `verdict`（allow / warn / block）。最终 ask/deny 仍归治理平面。

### 与 `@bah/core` 冻结的 `TicketRef` 的桥接（08 已落地）

`@bah/core` 的 `TicketRef` 只有 `{ ticketId, fingerprint, amount?, expiresAt }`；本包的五绑定需要
`sessionId` 与 `tool`。工具执行时能拿到 `ToolExecContext.sessionId` 与工具定义名，所以在**工具边界**
组装（`packages/bank/src/tools/tickets.ts`）：

```ts
const ref = {
  ticketId: coreTicket.ticketId,
  binding: {
    sessionId: ctx.sessionId,              // ToolExecContext
    tool: definition.name,                 // 工具定义名
    fingerprint: fingerprintOf(tool, args), // 工具边界重算（审批后改参数即失效）
    amountCents: yuanToCents(coreTicket.amount ?? 0),
    expiresAt: coreTicket.expiresAt,
  },
}
```

这一步刻意留在 08（工具族）而不是核心：核心不依赖运行时，五绑定才是核销的权威材料。
审批票据的 `issued → approved / blocked` 生命周期由 `tools/governance.ts` 的 `approval/request`
桥接同步（详见 [bank-tools.md](bank-tools.md) §3）。

### 4.1 冲正与执行 lease

**冲正**（`MockBankCore.reverse(txnId)`，不是 `BankCoreProvider` 的方法）：

- 落**两条流水**：原 `out / transfer` 保留，新增 `in / refund / reversalOf = 原 txnId`；
- 幂等键 = 原 `txnId`：重复调用返回首次结果，不重复回补余额；
- 只允许冲正"成功 + 转出 + transfer"的交易，其余 `txn-not-reversible`（宁可人工处理）；
- 当日额度口径改为**净转出**：当日 `out transfer` 之和 − 当日冲正 `refund` 之和（下限 0）。
  风控速度窗口与重复检测仍按原始流水计数（保守口径：发生过就先算上；要一并回退需另立规则）。
- 对 saga 暴露的是窄端口 `bank:compensation`（`BANK_COMPENSATION`，只含 `reverse` / `reversalOf`），
  不暴露票据、审批或任意账本写入面。**生产需换成银行核心的冲正/退款接口**。

**执行 lease**（`packages/runtime/src/policy/ticket.ts`）：

- `TicketLease = { leaseId, ticketId, expiresAt }`，独立类型，不与两份 `TicketRef` 合并；
- 治理桥接在 `approval/request` 签发时生成 `leaseId = lease:<ticketId>`，
  并把 **`min(票据 TTL, 签发时刻 + lease TTL)`** 写进 bank-core 五绑定的 `expiresAt`——
  核销点就是执行点，过期票据不会"钱先出去、账本再拦"；
- `lease.expiresAt <= 票据 expiresAt` 在配置与账本两处 fail-loud；`renewLease()` 只前移、不动票据 TTL；
- 回滚开关：`bank:tools.ticketLease.enforce: false`（退回只用票据 TTL）。

## 5. 造数四档

```ts
import { buildBankDataset, MockBankCore } from '@bah/bank'
const data = buildBankDataset({ seed: 7, tier: 'demo' })   // 同 seed + 同 tier + 同 now → 逐字段相同
const core = new MockBankCore({ data, now: () => 1_792_000_000_000 })
```

随机源是 `@bah/util` 的 `seededRandom`（mulberry32），**与快照夹具同源**：`scenario.json` 里录的
`randomSeed` 能重放出同一套数据。

### demo 档数据速查（演示脚本用）

| 项 | 值 |
|---|---|
| 用户 | 张三（`u-1`，手机 13800001111） |
| 活期账户 | `a-1` 余额 **¥12,345.67**（可用同额） |
| 定期 / 锁定 | `a-2` ¥50,000.00（不可用）；`a-3` ¥888.88 |
| 卡 | `c-1` 尾号 1234，日限 ¥5,000 / 月限 ¥20,000（借记）；`c-2` 虚拟卡尾号 5678（借记）；`c-3` 虚拟**信用卡**尾号 2468，授信额度 **¥5,000**、已用 ¥0（ADR-0015；日/月限额缺省 = 授信额度） |
| 收款人 | 王建国（`p-1`）**白名单**，首笔 30 天前 → 800 元转账不会触发"新收款人" |
| 理财 | `w-1` 稳盈 90 天 2.8% R1 起投 ¥100；`w-2` 债券 180 天 3.6% R2 起投 ¥500；`w-3` 混合一年 5.2% R3 起投 ¥1,000 |
| 持仓 | `h-1` 稳盈 500 份，成本 ¥500.00，市值 ¥508.00 |
| 订阅 | 视频会员 ¥30.00 / 月，下次扣费 5 天后 |

### 四档用途

| 档位 | 用途 | 关键点 |
|---|---|---|
| `demo` | 演示 | 8 笔历史流水；王建国白名单 |
| `stress` | 压测 | 3 用户 / 6 账户 / 300 笔流水 |
| `adversarial` | 安全用例 | 490,000/500,000 差 10,000 分；新收款人韩梅梅；00:00 夜间大额 120,000；10 分钟内 5 笔；订阅同额重复扣费 |
| `recurring` | 场景 5（订阅/代扣） | 固定脚本、无随机源；6 个月 × 2 账户；8 订阅 + 2 账单 + 1 分期；脏商户名（`STM*VIDEO` / `支付宝-云音乐` / `财付通-某某健身(朝阳店)`）；云音乐同额同日重复扣款；健身房协议已关但之后仍扣款（断供失败样本） |

> `recurring` 档的检测结果为 **11 条 series / 9 high / 1 medium / 1 low / 1 duplicate**（守卫用例见
> `packages/bank/src/forge/index.test.ts`）；`demo` 档另有 sha256 守卫，字节不得变化。

## 6. 风控预检六规则（`forge/risk.ts`）

| 规则 | 返回码 | 级别 | 触发 |
|---|---|---|---|
| 余额不足 | `insufficient-balance` | block | 本笔 > 可用余额 |
| 超日限额 | `daily-limit-exceeded` | warn（强制升红） | 当日已用 + 本笔 > 日限额（含已用/剩余） |
| 收款人异常 | `payee-new` | warn | 收款人未登记或 `binding = 'new'` |
| 夜间大额 | `night-large-amount` | warn | 东八区 22:00–06:00 且金额 ≥ 阈值 |
| 短时高频 | `velocity-high` | warn | 窗口内成功转出笔数 ≥ 上限（不含本笔） |
| 疑似重复 | `duplicate-transfer` | warn | 2 分钟内同账户、同收款人、同金额的成功转出（幂等提示，不阻断） |

- 夜间小时固定按 **UTC+8** 计算：跨机器一致，否则 CI 与开发机判决不同、快照回放会飘；
- 日累计 / 剩余额度只从账本推导（同账户、同 UTC 日、成功的 `transfer`），**换会话不重置**；
  卡上没配日限额时回落到 `limits.dailyTransferLimitCents`；
- 预检的 `block/warn` 只是业务解释，不是最终裁决（治理平面按 tier 决定 ask/deny）。

## 7. 测试与覆盖

规格用例全在 `packages/bank/src`（ID 与用例表逐条对应）：

| ID | 落点 |
|---|---|
| T-BANK-001 seeded 复现 | `forge/index.test.ts` |
| T-BANK-002 合法核销 / 余额变动 | `core/mock.test.ts` + `core/ticket.test.ts` |
| T-BANK-003 票据重放 | `core/ticket.test.ts` + `core/mock.test.ts` |
| T-BANK-004 票据过期 | `core/ticket.test.ts` |
| T-BANK-005 指纹/绑定变化 | `core/ticket.test.ts`（五绑定逐项） |
| T-BANK-006 未审批票据 | `core/ticket.test.ts` |
| T-BANK-007 日累计权威口径 | `core/mock.test.ts` |
| T-BANK-008 换会话不重置 | `core/mock.test.ts` |
| T-BANK-009 demo 主体与白名单收款人 | `forge/index.test.ts` |
| T-BANK-010 adversarial 档 | `forge/index.test.ts` |
| T-BANK-011 风控预检规则 | `forge/risk.test.ts` |
| T-BANK-012 余额不足 | `core/mock.test.ts` |

工具族的用例在 `packages/bank/src/tools/*.test.ts`，ID 与期望见
[bank-tools.md](bank-tools.md) §8（T-TOOLS-001~010）。

补充用例：票据并发核销（两个并发 `createTransfer` 只成功一个）、状态机边角（重复签发 / 幂等 /
已核销不可再阻断）、分页与非法游标、账单环比与三类异常、金额校验 fail-loud、UTC 账期解析。

覆盖率：`bank/core/` 与 `bank/forge/` 进强制名单（逐文件行覆盖 100%），
`core/provider.ts` 是纯类型模块、在 `vitest.config.ts` 中排除（与 `runtime/src/tools/types.ts` 同例）。

## 8. 策略外置（S2/S3）：判决从哪来

`bank:tools.policy.engine` 有两个取值，缺省 `legacy`：

| 取值 | 判决来源 | 用途 |
|---|---|---|
| `legacy` | `tools/tier.ts` 的 `decide()`（代码分支） | 整体回退开关；无需删 `policies/`、无需重启策略服务 |
| `bundle` | `policies/bank-tier/1.0.0` 编译出的决策表（宿主 `policy:rules` 提供服务） | 生产默认（headless/web/web-plan/plan） |

`engine: bundle` 时，治理平面的顺序不变：身份 → 预检 → 生效上限 `min(core, config)` →
策略求值（只给 `level/reason`，作为 escalation）→ 硬规则（`no-identity` / `verify-locked` /
红级挑战）→ 票据/审批。**策略不能把红降黄，也不能让锁定/未绑定放行**；策略 deny 覆盖
allow，但绿级读工具不咨询策略（TC-06）。

审计口径：`tier/decided` 带 `engineSource / policyVersion / ruleIds / paramsDigest`，
bundle 实际求值时还有 `evidence`（完整输入 + `inputDigest`）；链上镜像为
`policy/decision`（v2 信封）。`policy:explain` 按记录 digest 找归档 bundle 复算，
归档缺失显式失败，绝不用新策略重算历史。

已知边界：`transfer_preview` 的 `effectiveTier` 仍是 legacy 展示口径（试算卡片只回答
"执行时大概会是黄还是红"）；权威判决只来自治理平面。作者/运维手册见
[policy.md](policy.md)。

## 9. 已知边界（不是遗漏，是记账）

| 项 | 现状 | 计划 |
|---|---|---|
| card / subscription 的 Provider 方法 | 九实体与造数已落；读写方法未加入 `BankCoreProvider` | 后续补齐 |
| 与 `@bah/core` `TicketRef` 的桥接 | 08 已落地（`tools/tickets.ts` + `tools/governance.ts`） | 09 接管审批服务与挑战链 |
| 金额单位 | 核心面全是「分」；工具参数是「元」 | 08 的工具层用 `yuanToCents` 转换一次 |
| 日 / 账期 | 固定 UTC 切分 | 夜间大额是唯一本地口径（UTC+8）；如需按客户时区切日，属插件线配置扩展 |
| 状态持久化 | 全内存；重启回到造数初始态 | 真实对接只换 Provider；mock 不落盘 |
| 文件命名 | 票据状态机落 `core/ticket.ts`（§5 写的是 `core/tickets.ts`） | 以覆盖率名单与 `@bah/bank` 单数模块习惯为准， |
