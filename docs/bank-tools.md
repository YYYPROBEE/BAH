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

## 3. 三级权限与票据链（08 已落地的一段）

```text
模型调用
  │ tool/call 落账（含声明 tier）
  ▼
tools/pre-execute（waterfall）
  ├─ 身份：`BANK_IDENTITY` 无绑定 → deny no-identity
  ├─ transfer_create：bank-core previewTransfer →
  │    当日累计含本笔 > 日限额 → 红（daily-limit）
  │    收款人 binding = new     → 红（new-payee）
  │    余额不足等 block 级风险   → deny（不进入审批）
  ├─ 绿 → allow（交还下游判决）
  ├─ 黄 → ask + TicketDraft（ttl 来自 config）
  └─ 红 → ask + challenge（sms / face / ushield，来自 config）
  ▼
approval/request（waterfall）
  ├─ 签发 bank-core 五绑定票据（会话 / 工具 / 参数指纹 / 金额 / TTL）
  ├─ 渠道应答者决定 allowed-once / rejected / unavailable
  └─ 同步 issued → approved / blocked
  ▼
tools/execute → 工具体
  └─ 工具边界组装 TicketRef → bank-core redeem()（唯一核销属主）
  ▼
tools/result → 失败且票据仍 approved → blocked（不留下"已批未用"的票据）
```

**判定是"取高不取低"**：声明级别是下限；金额 / 收款人只能上调。
指纹由 `fingerprintOf(tool, args)`（键序无关）重算，审批后改参数会在
`TicketStore.redeem()` 处被拒（`ticket-binding-mismatch`），不是靠工具自觉。

### 与 09 的分工

| 能力 | 08 现状 | 09 接管 |
|---|---|---|
| `decide()` 判定函数 | `tools/tier.ts`（声明 + 金额/收款人升级） | 补 `risky_calls`、跨 turn 状态、完整矩阵 |
| 审批服务 | `approval/request` 桥接（票据生命周期） | `@bah/interaction` 的应答者、超时归一化、双渠道竞答 |
| 会话身份绑定 | `SessionIdentityStore`（服务键 `bank:identity`）：`identity/bound` 落账 + 回放恢复；`demoUserId` 只是显式演示引导 | credentials：mock 短信 / IM 映射 / Web 登录调用同一个 `BANK_IDENTITY.bind` |
| 强验证挑战链 | 挑战 / 锁定 / 三渠道工具可用 | 红级 `ask+challenge` 自动签发挑战并串联审批弹窗 |

## 4. 身份与配置

### 4.1 会话身份（08 已并入）

`bank:tools` 启动时：

1. 建 `SessionIdentityStore`，注册服务键 `bank:identity`（`BANK_IDENTITY`）；
2. 从本会话日志恢复 `identity/bound`（回放 / 重启后身份不丢）；
3. 若 profile 显式写了 `demoUserId` 且当前绑定不同，则 `bind()` + 落一条 `identity/bound`
   （`method: 'demo-config'`）。

09 的 credentials 只需要：

```ts
ctx.get(BANK_IDENTITY).bind(sessionId, userId)
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
    ticketTtlSeconds: 120
    computeTimeoutMs: 5000
    redChallenge: sms
    verify: { successAfter: 1, maxAttempts: 3, lockMinutes: 30 }
```

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
| `read/accounts` `read/balance` `read/txns` `read/bill-analyzed` `read/bill-report` `read/analysis` | `{ result }` | 结果整块落账，卡片可重建 |
| `read/wealth` | `{ op: 'list' \| 'compare', result }` | 带 `disclaimerId` |
| `transfer/preview` `transfer/created` `wealth/purchased` | `{ result }` | 写操作只在成功时落 |
| `verify/face` `verify/sms` `verify/ushield` | `{ result }` | 每次尝试都落 |
| `verify/locked` | `{ sessionId, channel, until, attempts }` | 连续失败触发的会话级锁定 |

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
| T-TOOLS-008 | 三连败 → 锁 30 分钟 + `verify/locked` | 同上 |
| T-TOOLS-009 | presenter 纯度 | `tools/catalog.test.ts` |
| T-TOOLS-010 | 目录与源码一致（篡改即红） | `tools/catalog.test.ts` + `pnpm gate` |

headless 实跑：

```bash
pnpm bah --profile headless --prompt 查一下我的余额 --session s-bank09 --jsonl .tmp-bank09
# 22 条事件：identity/bound → tool/call → read/balance（卡片数据）→ tool/result → 文本收尾
```

## 9. headless 演示脚本片段

`core:model` 的 mock 脚本可以按顺序驱动多个工具（headless 无审批应答者，**写操作**会被
`unavailable` 拒绝，这是默认拒绝语义，不是 bug）：

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

写操作（`transfer_create` / `wealth_purchase`）需要 09 的审批应答者；强验证（`verify_face` /
`verify_sms` / `verify_ushield`）需要红级挑战链签发挑战。两者的演示见施工单 09 的幕 3 排练。

## 10. 已知边界

| 项 | 现状 | 计划 |
|---|---|---|
| 红级强验证串联 | 红级 `ask` 带 `challenge`，但挑战的签发/串联由 09 完成；08 的 `verify_*` 只保证被调用时可用 | 09 §6 |
| 日限额与执行 | 升红后经批准仍会执行（bank-core 不拦日限额；规格把日限额放在权限升级） | 09 若需要"拒绝"而非"升红"需改判定 |
| card / subscription | 九实体与造数已落，Provider 方法未加（P1 工具才需要） | 08 P1 / 09 |
| 定时转账 / AA 拆分 | `transfer_create` 的 `when` 只支持 `now`，未来时间返回 `unsupported-schedule` | P1 `transfer_schedule` / `transfer_split` |
| 单应用单会话 | 票据五绑定里的 `sessionId` 来自 `bah:run`（一应用一会话） | 与 R52 一并评估多会话 |
