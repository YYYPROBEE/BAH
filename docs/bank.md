# 仿真银行 bank（施工单 07 落地说明）

> 读者：写银行工具族的人（施工单 08）、做审批票据的人（09）、写渠道 / 演示脚本的人。
> 规格权威仍是 `BAH-施工文档集/07-仿真银行bank.md`；本文只讲**本仓怎么落地**、**金额与时序口径**、
> 以及**留给 08/09 的桥接点**。

## 1. 模块图

```text
packages/bank/src/
├─ core/
│  ├─ model.ts      九实体 + 品牌 ID（bankIds 铸造点）+ 金额换算 + BankLimits
│  ├─ provider.ts   BankCoreProvider 接口与请求/响应类型（纯类型，零可执行行）
│  ├─ ticket.ts     TicketStore：issued → approved → redeemed | blocked（核销唯一属主）
│  ├─ mock.ts       MockBankCore：内存账本、预检、转账/理财、日累计推导
│  └─ time.ts       UTC 日 / 账期口径（dayKey / monthKey / periodRange）
└─ forge/
   ├─ index.ts      buildBankDataset：demo / stress / adversarial 三档造数
   └─ risk.ts       风控预检五规则 + 夜间时段判定
```

`tools/` 与 `verify/` 留给施工单 08（银行工具族与工具目录校验）。

## 2. 九实体与金额口径

| 实体 | 关键字段（本仓命名） |
|---|---|
| `User` | `id` / `name` / `phone` / `riskGrade`（R1–R5）/ `verified` / `strongAuth` |
| `Account` | `type`（current / fixed / locked）/ `balanceCents` / `availableCents` / `status` |
| `Card` | `tail`（只存尾号）/ `type` / `status` / `dailyLimitCents` / `monthlyLimitCents` |
| `Transaction` | `at` / `amountCents` / `direction` / `counterparty` / `category` / `channel` / `status` |
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
| 签发 | 治理平面的 `ask` 判决调用 `TicketStore.issue()`（施工单 09 接线） |
| 批准 | `approve()`：幂等；过期会先置 `blocked(expired)` 再抛 |
| **核销属主** | `redeem()`：同步 CAS；检查与转移之间**没有 await**，JS 单线程内原子 |
| 五绑定 | 会话 / 工具 / 参数指纹 / 金额 / TTL；逐项比对，任何一项不同都拒绝 |
| 失败不消耗 | 除"过期"会顺带置 `blocked`，其余拒绝都不改票据状态 |
| 记账与状态分离 | `tools/result` 侧只落 `approval/decided` 生命周期，不改票据状态（施工单 09） |

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

### 与 `@bah/core` 冻结的 `TicketRef` 的桥接（08/09 要接）

`@bah/core` 的 `TicketRef` 只有 `{ ticketId, fingerprint, amount?, expiresAt }`；本包的五绑定需要
`sessionId` 与 `tool`。工具执行时能拿到 `ToolExecContext.sessionId` 与工具定义名，所以在**工具边界**
组装：

```ts
const ref = {
  ticketId: coreTicket.ticketId,
  binding: {
    sessionId: ctx.sessionId,              // ToolExecContext
    tool: definition.name,                 // 工具定义名
    fingerprint: coreTicket.fingerprint,
    amountCents: yuanToCents(coreTicket.amount ?? 0),
    expiresAt: coreTicket.expiresAt,
  },
}
```

这一步刻意留在 08（工具族）而不是核心：核心不依赖运行时，五绑定才是核销的权威材料。

## 5. 造数三档

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
| 用户 | 王建国（`u-1`，手机 13800001111） |
| 活期账户 | `a-1` 余额 **¥12,345.67**（可用同额） |
| 定期 / 锁定 | `a-2` ¥50,000.00（不可用）；`a-3` ¥888.88 |
| 卡 | `c-1` 尾号 1234，日限 ¥5,000 / 月限 ¥20,000；`c-2` 虚拟卡尾号 5678 |
| 收款人 | 王建国（`p-1`）**白名单**，首笔 30 天前 → 800 元转账不会触发"新收款人" |
| 理财 | `w-1` 稳盈 90 天 2.8% R1 起投 ¥100；`w-2` 债券 180 天 3.6% R2 起投 ¥500；`w-3` 混合一年 5.2% R3 起投 ¥1,000 |
| 持仓 | `h-1` 稳盈 500 份，成本 ¥500.00，市值 ¥508.00 |
| 订阅 | 视频会员 ¥30.00 / 月，下次扣费 5 天后 |

### 三档用途

| 档位 | 用途 | 关键点 |
|---|---|---|
| `demo` | 演示 | 8 笔历史流水；王建国白名单 |
| `stress` | 压测 | 3 用户 / 6 账户 / 300 笔流水 |
| `adversarial` | 安全用例 | 490,000/500,000 差 10,000 分；新收款人韩梅梅；00:00 夜间大额 120,000；10 分钟内 5 笔；订阅同额重复扣费 |

## 6. 风控预检五规则（`forge/risk.ts`）

| 规则 | 返回码 | 级别 | 触发 |
|---|---|---|---|
| 余额不足 | `insufficient-balance` | block | 本笔 > 可用余额 |
| 超日限额 | `daily-limit-exceeded` | block | 当日已用 + 本笔 > 日限额（含已用/剩余） |
| 收款人异常 | `payee-new` | warn | 收款人未登记或 `binding = 'new'` |
| 夜间大额 | `night-large-amount` | warn | 东八区 22:00–06:00 且金额 ≥ 阈值 |
| 短时高频 | `velocity-high` | warn | 窗口内成功转出笔数 ≥ 上限（不含本笔） |

- 夜间小时固定按 **UTC+8** 计算：跨机器一致，否则 CI 与开发机判决不同、快照回放会飘；
- 日累计 / 剩余额度只从账本推导（同账户、同 UTC 日、成功的 `transfer`），**换会话不重置**；
  卡上没配日限额时回落到 `limits.dailyTransferLimitCents`；
- 预检的 `block/warn` 只是业务解释，不是最终裁决（治理平面按 tier 决定 ask/deny）。

## 7. 测试与覆盖

规格用例全在 `packages/bank/src`（ID 与施工单逐条对应）：

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
| T-BANK-009 demo 王建国 | `forge/index.test.ts` |
| T-BANK-010 adversarial 档 | `forge/index.test.ts` |
| T-BANK-011 风控预检五规则 | `forge/risk.test.ts` |
| T-BANK-012 余额不足 | `core/mock.test.ts` |

补充用例：票据并发核销（两个并发 `createTransfer` 只成功一个）、状态机边角（重复签发 / 幂等 /
已核销不可再阻断）、分页与非法游标、账单环比与三类异常、金额校验 fail-loud、UTC 账期解析。

覆盖率：`bank/core/` 与 `bank/forge/` 进强制名单（逐文件行覆盖 100%），
`core/provider.ts` 是纯类型模块、在 `vitest.config.ts` 中排除（与 `runtime/src/tools/types.ts` 同例）。

## 8. 已知边界（不是遗漏，是记账）

| 项 | 现状 | 计划 |
|---|---|---|
| card / subscription 的 Provider 方法 | 九实体与造数已落；读写方法未加入 `BankCoreProvider` | 施工单 08 的工具对齐时补齐（07 §2 明确写了"同理"） |
| 与 `@bah/core` `TicketRef` 的桥接 | 本包用五绑定的 `TicketRef` | 工具边界组装（见 §4 代码），属 08/09 |
| 金额单位 | 核心面全是「分」；工具参数是「元」 | 08 的工具层用 `yuanToCents` 转换一次 |
| 日 / 账期 | 固定 UTC 切分 | 夜间大额是唯一本地口径（UTC+8）；如需按客户时区切日，属插件线配置扩展 |
| 状态持久化 | 全内存；重启回到造数初始态 | 真实对接只换 Provider；mock 不落盘 |
| 文件命名 | 票据状态机落 `core/ticket.ts`（施工单 07 §5 写的是 `core/tickets.ts`） | 以覆盖率名单与 `@bah/bank` 单数模块习惯为准，已在 PROGRESS 记账 |
