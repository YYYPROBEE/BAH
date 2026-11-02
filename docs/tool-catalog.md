# 银行工具目录

> 本文件由 `pnpm tool-catalog` 从 `packages/bank/src/tools/specs.ts` 生成，**不要手改**。
> 门禁 `verify-tool-catalog` 会逐字比对；改工具定义后请重新生成。

共 **30** 个工具（上限 31）。级别由工具定义处声明，治理平面统一解释。

| # | 工具 | 级别 | 场景 | 参数 | 落账事件 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `account_list` | green | 账户/账单 | 无 | `read/accounts` | 列出当前用户名下全部账户与卡片（账户尾号/类型/余额；卡尾号/类型/状态/日限额）。用户问“我有几张卡/哪些账户/卡什么状态”时用；不要用它查单笔流水或账单分析。 |
| 2 | `account_balance` | green | 账户/账单 | accountId? | `read/balance` | 查询某个账户的余额与可用余额（含冻结金额说明）。用户问“我还有多少钱/余额多少”时用；不要用它做转账或查询历史交易。 |
| 3 | `txn_query` | green | 账户/账单 | accountId?, range{from*, to*}?, category?, direction?, page?, cursor?, limit? | `read/txns` | 按时间区间、分类、收支方向分页查询交易流水。用户问“最近花了什么/某笔转账到了吗”时用；不要用它做汇总分析（用 bill_analyze）。 |
| 4 | `bill_analyze` | green | 账户/账单 | period*, groupBy?, month?, year?, monthOffset?, monthOfYear? | `read/bill-analyzed` | 按月度/季度/年度汇总收支、分类占比、环比与异常（大额 / 夜间 / 重复扣费）。用户问“这个月钱花哪了/帮我分析账单”时用；要看历史某个月或某个自然年时用 month / year 指定；不要用它列单笔明细（用 txn_query）。 |
| 5 | `bill_report` | green | 账户/账单 | period*, format?, month?, year?, monthOffset?, monthOfYear? | `read/bill-report` | 按月度/季度/年度生成一段可读的账单报告（摘要或明细）。用户要“出一份账单报告/发给我的报告”时用；不要用它做单笔交易查询。 |
| 6 | `analysis_calc` | green | 账户/账单 | code*, data? | `read/analysis` | 在受限算术语言里对已给数据做算术/占比计算：无网络、无文件、无循环，受运算预算与时限双重约束。用户说“帮我算占比/算一下这个数”且数据已由上一步工具给出时用；不要用它访问账户或发起任何写操作。 |
| 7 | `transfer_preview` | green | 转账 | amount*, payee{name*, phone?, payeeId?, memo?}*, remark?, viaCardId? | `transfer/preview` | 转账试算 + 风控预检：金额、收款人、到账时间、当日已用/剩余额度与风险结论。用户表达“给某人转多少钱/上次那个转账再来一次”但还没确认执行时**先用它**；不要用它真正扣款（用 transfer_create）。 |
| 8 | `transfer_create` | yellow | 转账 | amount*, payee{name*, phone?, payeeId?, memo?}*, remark?, when?, idempotencyKey?, viaCardId? | `transfer/created` | 发起一笔转账（写操作，必然进入审批；超过日累计或新收款人会升为红色强验证）。用户**明确确认**“就转/确认转账”后才用；只做试算请用 transfer_preview，不要用它绕过审批。 |
| 9 | `aa_create` | yellow | 转账 | action?, groupId?, participant?, expiresInHours?, title?, totalYuan?, split?, participants? | `aa/created`（读分支：`read/aa`） | AA 拆分收款（动作式）：`action="create"` 按人数均分或自定义份额建组（黄档写操作）；`action="status"` 按 groupId 查询（只读查询，不签票）；`action="collect"` 是**模拟代收**（demo 口径，本进程替某位参与人把份额记进组织者账户并写入账流水，黄档写操作）；`action="decline"` 记录某位参与人明确拒绝（黄档写操作）；`action="close"` 由组织者提前结束收款（剩余未付转过期并按收口规则定组状态，黄档写操作）。用户说“我们 AA/一共多少钱几个人分”时用；有人拒付用 decline，组织者不想再等用 close。不要用它直接扣款或伪造真实到账——跨人真实收款需要行内清算接口。 |
| 10 | `wealth_list` | green | 理财 | filter{riskGrade?, kind?, maxTermDays?}? | `read/wealth` | 按风险等级、产品类型、期限筛选理财产品（结果必带风险提示 disclaimerId）。用户问“有什么稳健理财/推荐产品”时用；不要用它购买产品（用 wealth_purchase）。 |
| 11 | `wealth_compare` | green | 理财 | ids* | `read/wealth` | 把 2–4 个指定理财产品放在一起对比（期限、风险等级、预期收益、起投额）。用户已经点名几个产品、要求“对比一下”时用；不知道产品 ID 时不要硬猜，先用 wealth_list，也不要把它当购买入口（购买用 wealth_purchase）。 |
| 12 | `wealth_purchase` | red | 理财 | productId*, amount*, accountId? | `wealth/purchased` | 购买理财产品（红色写操作：必须强验证 + 审批后执行）。用户明确选定产品、金额并确认购买时用；只查询或对比请用 wealth_list / wealth_compare，不要在未确认前替用户下单。 |
| 13 | `risk_assess` | yellow | 理财 | action*, questionnaireId?, answers? | `risk/assessed`（读分支：`read/risk-questions`） | 风险测评（服务端问卷）：先 `action="questions"` 取服务端问卷，把题目原样交给用户逐题作答，再由用户确认后用 `action="submit"` 提交。用户明确要做风险测评 / 更新风险等级时用；**不得替用户作答或推测选项**，不提交合法问卷 ID 就落不了档，也不要用它直接指定等级或购买产品。 |
| 14 | `wealth_positions` | green | 理财 | 无 | `read/wealth-positions` | 列出当前用户的理财持仓（份额/成本/市值/盈亏与合计）。用户问“我买了什么理财/持仓收益多少”时用；不要用它申购或赎回（申购用 wealth_purchase，赎回用 wealth_redeem）。 |
| 15 | `wealth_redeem` | red | 理财 | holdingId?, productId?, amountYuan? | `wealth/redeemed` | 赎回理财产品（红色写操作：必须强验证 + 审批后执行）。用户明确说“赎回/卖掉某笔理财”时用；holdingId 与 productId 二选一，amount 缺省=全部赎回；不要用它购买产品或查询持仓。 |
| 16 | `verify_face` | green | 强验证 | challengeId* | `verify/face` | 红色操作的挑战链要求人脸验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。 |
| 17 | `verify_sms` | green | 强验证 | challengeId* | `verify/sms` | 红色操作的挑战链要求短信验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。 |
| 18 | `verify_ushield` | green | 强验证 | challengeId* | `verify/ushield` | 红色操作的挑战链要求 U 盾验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。 |
| 19 | `card_report_lost` | red | 账户/账单 | cardId* | `card/reported-lost` | 挂失银行卡（红档写操作，不可逆：挂失后该卡即刻不可用），必然进入审批并触发强验证。用户**明确说要挂失**后才用；只是询问卡状态请用 account_list，不要用它试探。 |
| 20 | `fund_lock` | yellow | 账户/账单 | action*, amountYuan? | `transfer/created`（读分支：`read/balance`） | 锁定 / 释放活期资金（写操作）：锁定 = 把活期余额划到**本人锁定账户**（earmark：可用余额减少、总资产不变）；释放 = 从锁定账户划回活期。用户说“先锁定 1000 元活期/这笔钱留着别花/解除锁定”时用；不要用它给他人转账（用 transfer_create），也不要把它当挂失（用 card_report_lost）。 |
| 21 | `sub_cancel` | yellow | 账户/账单 | subscriptionId*, confirmContract?, mode? | `sub/cancelled` | 取消自动扣款订阅（黄档写操作）。用户明确要求“取消/退订某个自动续费”后用；合约期内需显式确认（confirmContract），只想停一个订阅用本工具，要关整个商户的代扣协议用 sub_authorize。不要用它代替订阅查询；不要在用户未确认合约后果时取消。 |
| 22 | `sub_list` | green | 账户/账单 | subscriptionId?, limit? | `read/subscriptions` | 列出订阅并识别周期扣款：三分法汇总（订阅/账单/分期）、涨价、闲置、断供核验，以及单条订阅详情。用户问“我有哪些订阅/每月固定扣多少/这项为什么多了”时用；不要用它取消订阅（用 sub_cancel）或关闭代扣协议（用 sub_authorize）。 |
| 23 | `sub_watch` | yellow | 账户/账单 | subscriptionId*, watch*, aheadDays? | `sub/watch-updated` | 设置订阅提醒或标注（黄档写操作）：remind=到期提醒、idle=我不用了、none=清除。用户说“到期提醒我/这个我不用了”时用；不要用它改订阅状态或关闭代扣（取消用 sub_cancel，关协议用 sub_authorize）。 |
| 24 | `sub_authorize` | yellow | 账户/账单 | merchant* | `sub/authorization-revoked` | 关闭某商户的代扣协议（黄档写操作，只关不开，影响该商户全部订阅）。用户要求“彻底停掉这家扣款”时用；不要用它停单个订阅（用 sub_cancel）。恢复扣款需在商户侧重新签约，本工具不提供恢复。 |
| 25 | `card_freeze` | yellow | 卡片 | cardId*, reason? | `card/state-changed` | 冻结银行卡（黄档写操作，可逆：随时可解冻）。用户怀疑盗刷、卡暂时找不到、或想停用某张卡时用；卡已确认丢失请用 card_report_lost（红档、不可逆），不要用本工具代替挂失。 |
| 26 | `card_unfreeze` | red | 卡片 | cardId* | `card/state-changed` | 解冻银行卡（红档写操作：必须强验证 + 审批）。用户明确要求恢复用卡、并已确认卡在本人手中时用；卡已挂失请走补发流程，不要用本工具解挂。 |
| 27 | `card_apply` | yellow | 卡片 | accountId?, type?, kind?, creditLimitYuan?, dailyLimitYuan?, monthlyLimitYuan?, replacesCardId? | `card/issued` | 申请一张新卡（黄档写操作，缺省虚拟借记卡）。用户明确说“办一张虚拟卡/新卡”时用；说“信用卡/信用额度/授信额度”时传 kind=credit 并给 creditLimitYuan（此时两个限额缺省等于授信额度）；挂失后要补一张时用 replacesCardId 指定原卡（原卡必须已挂失）；不要用它挂失、冻结或调整已有卡额度。注意区分两种“额度”：creditLimitYuan 是**信用卡授信额度**（支付时真判"已用 + 本笔 ≤ 授信"），dailyLimitYuan/monthlyLimitYuan 是**交易限额**（防单日/近 30 天大额，按 min(卡日限额, Config 日限额) 与同卡滚动窗口判定）。 |
| 28 | `card_limit_set` | red | 卡片 | cardId*, creditLimitYuan?, dailyLimitYuan?, monthlyLimitYuan? | `card/limits-changed` | 调整银行卡额度（红档写操作：必须强验证 + 审批）。两种额度都从这里调，但语义不同：creditLimitYuan 是**信用卡授信额度**（仅 kind=credit 的卡接受；降额不得低于已用，否则报 credit-in-use），dailyLimitYuan/monthlyLimitYuan 是**交易限额**（日限额生效值取 min(卡日限额, Config 日限额)；月限额按同卡近 30 天滚动窗口判定，不是自然月）。三项可同时给，均校验；日限额不得高于月限额。不要用它冻结/挂失卡片。 |
| 29 | `card_restriction` | yellow | 卡片 | cardId*, mode*, kind?, value?, note? | `card/restrictions-changed` | 设置或解除卡片的交易限制（黄档写操作）：online=线上交易、overseas=境外交易、category=指定商户品类。online/overseas 对以卡转账硬阻断；category 在本系统的 mock 卡消费通道上拦截对应品类（品类值必须是已知键：dining/coffee/grocery/transit/shopping/digital/other）。用户说“关掉这张卡的线上支付/境外支付/某类消费”或“恢复”时用；整卡停用请用 card_freeze，不要用本工具代替冻结/挂失。 |
| 30 | `password_change` | red | 强验证 | action* | `security/password-changed`（读分支：`read/password-status`） | 发起/查询交易密码修改（红档写操作，ADR-0014）：action=request 签一张一次性交接票据并给出安全页路径，action=status 只读上次改密时刻与剩余尝试次数。用户说“改交易密码/忘记交易密码想重设/看看密码还能试几次”时用；不要用它接收或转述任何密码明文（本工具的参数里只有 action，密码只能在安全页表单里填），也不要用它改登录密码（登录密码走登录页）。 |

## 说明

- **tier**：`green` 自动执行；`yellow` 展示详情 + 确认（签发票据）；`red` 强验证 + 确认。
- **落账事件**：成功执行后写入会话日志的领域事件；卡片由事件 + 持久化结果派生。
- **金额单位**：模型参数是「元」，核心与事件是「分」（字段名带 `Cents`）。
- **上限**：新增工具先删旧的（28 上限由门禁强制）。
