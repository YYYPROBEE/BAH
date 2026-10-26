# 银行工具目录（施工单 08）

> 本文件由 `pnpm tool-catalog` 从 `packages/bank/src/tools/specs.ts` 生成，**不要手改**。
> 门禁 `verify-tool-catalog` 会逐字比对；改工具定义后请重新生成。

共 **16** 个工具（上限 28）。级别由工具定义处声明，治理平面统一解释。

| # | 工具 | 级别 | 场景 | 参数 | 落账事件 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `account_list` | green | 账户/账单 | 无 | `read/accounts` | 列出当前用户名下全部银行账户（尾号、类型、状态、余额）。用户问“我有几张卡/哪些账户”时用；不要用它查单笔流水或账单分析。 |
| 2 | `account_balance` | green | 账户/账单 | accountId? | `read/balance` | 查询某个账户的余额与可用余额（含冻结金额说明）。用户问“我还有多少钱/余额多少”时用；不要用它做转账或查询历史交易。 |
| 3 | `txn_query` | green | 账户/账单 | accountId?, range{from*, to*}?, category?, direction?, page?, cursor?, limit? | `read/txns` | 按时间区间、分类、收支方向分页查询交易流水。用户问“最近花了什么/某笔转账到了吗”时用；不要用它做汇总分析（用 bill_analyze）。 |
| 4 | `bill_analyze` | green | 账户/账单 | period*, groupBy? | `read/bill-analyzed` | 按月度或季度汇总收支、分类占比、环比与异常（大额 / 夜间 / 重复扣费）。用户问“这个月钱花哪了/帮我分析账单”时用；不要用它列单笔明细（用 txn_query）。 |
| 5 | `bill_report` | green | 账户/账单 | period*, format? | `read/bill-report` | 生成一段可读的账单报告（摘要或明细）。用户要“出一份账单报告/发给我的报告”时用；不要用它做单笔交易查询。 |
| 6 | `analysis_calc` | green | 账户/账单 | code*, data? | `read/analysis` | 在受限算术语言里对已给数据做算术/占比计算：无网络、无文件、无循环，受运算预算与时限双重约束。用户说“帮我算占比/算一下这个数”且数据已由上一步工具给出时用；不要用它访问账户或发起任何写操作。 |
| 7 | `transfer_preview` | green | 转账 | amount*, payee{name*, phone?, payeeId?, memo?}*, remark? | `transfer/preview` | 转账试算 + 风控预检：金额、收款人、到账时间、当日已用/剩余额度与风险结论。用户表达“给某人转多少钱/上次那个转账再来一次”但还没确认执行时**先用它**；不要用它真正扣款（用 transfer_create）。 |
| 8 | `transfer_create` | yellow | 转账 | amount*, payee{name*, phone?, payeeId?, memo?}*, remark?, when?, idempotencyKey? | `transfer/created` | 发起一笔转账（写操作，必然进入审批；超过日累计或新收款人会升为红色强验证）。用户**明确确认**“就转/确认转账”后才用；只做试算请用 transfer_preview，不要用它绕过审批。 |
| 9 | `wealth_list` | green | 理财 | filter{riskGrade?, kind?, maxTermDays?}? | `read/wealth` | 按风险等级、产品类型、期限筛选理财产品（结果必带风险提示 disclaimerId）。用户问“有什么稳健理财/推荐产品”时用；不要用它购买产品（用 wealth_purchase）。 |
| 10 | `wealth_compare` | green | 理财 | ids* | `read/wealth` | 把 2–4 个指定理财产品放在一起对比（期限、风险等级、预期收益、起投额）。用户已经点名几个产品、要求“对比一下”时用；不知道产品 ID 时不要硬猜，先用 wealth_list，也不要把它当购买入口（购买用 wealth_purchase）。 |
| 11 | `wealth_purchase` | red | 理财 | productId*, amount*, accountId? | `wealth/purchased` | 购买理财产品（红色写操作：必须强验证 + 审批后执行）。用户明确选定产品、金额并确认购买时用；只查询或对比请用 wealth_list / wealth_compare，不要在未确认前替用户下单。 |
| 12 | `verify_face` | green | 强验证 | challengeId* | `verify/face` | 红色操作的挑战链要求人脸验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。 |
| 13 | `verify_sms` | green | 强验证 | challengeId* | `verify/sms` | 红色操作的挑战链要求短信验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。 |
| 14 | `verify_ushield` | green | 强验证 | challengeId* | `verify/ushield` | 红色操作的挑战链要求 U 盾验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。 |
| 15 | `card_report_lost` | red | 账户/账单 | cardId* | `card/reported-lost` | 挂失银行卡（红档写操作，不可逆：挂失后该卡即刻不可用），必然进入审批并触发强验证。用户**明确说要挂失**后才用；只是询问卡状态请用 account_list，不要用它试探。 |
| 16 | `sub_cancel` | yellow | 账户/账单 | subscriptionId* | `sub/cancelled` | 取消自动扣款订阅（黄档写操作，可逆：用户可重新签约）。用户明确要求"取消/退订某个自动续费"后用；查订阅明细请用 txn_query，不要用它代替查询。 |

## 说明

- **tier**：`green` 自动执行；`yellow` 展示详情 + 确认（签发票据）；`red` 强验证 + 确认。
- **落账事件**：成功执行后写入会话日志的领域事件；卡片由事件 + 持久化结果派生（施工单 08 §4）。
- **金额单位**：模型参数是「元」，核心与事件是「分」（字段名带 `Cents`）。
- **上限**：新增工具先删旧的（28 上限由门禁强制）。
