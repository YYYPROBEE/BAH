# ADR-0015 · 信用卡授信额度落到支付路径（`Card.kind` + `creditLimitCents`）

- 状态：**已采纳**（2026-11-01）
- 关联：赛题场景 4「额度调整」、`docs/contracts/event-table.md` §3.4/§3.5、`docs/bank-tools.md` §2、
  `facts.md` §2、ADR-0006（卡片状态）/ ADR-0012（卡限额与 mock 收单）
- 影响面：`packages/bank/src/core/{model,provider,mock}.ts`、
  `packages/bank/src/forge/index.ts`、
  `packages/bank/src/tools/{specs,dto,result-schemas,account-ops,queries,presenters,approval-details,events}.ts`、
  `packages/llm/src/demo/router.ts`（离线路由话术，见 §2.7）

> 编号说明：`0014` 已被 交易密码交办占用，本设计顺延取 0015。

---

## 1 背景

赛题场景 4 写的是「额度调整」。审查现状：

- 仓库里唯一的"额度"是 `card_limit_set` 的 `dailyLimitYuan` / `monthlyLimitYuan`——
  那是**借记卡的交易限额**（防大额转出），生效口径是
  `min(卡日限额, Config 日限额)` 与"同卡近 30 天滚动窗口"（ADR-0012）。
- `Card` 上没有"这张卡是信用卡"这个概念，更没有授信额度，`spendOnCard` 也不判额度。

于是审阅者问"这是信用卡提额吗"只能答"不是"。病根与 B-02/B-03（ADR-0012 §1）同型：
**模型里没有参数，判决里当然没有读取点**。

本 ADR 的决定是：把"授信额度"做成**一等模型字段**，并让它成为卡消费通道上的
**主约束**（不是展示字段）。只加字段、不接判定，等于假实现——本条是判据。

## 2 决策

### 2.1 模型：`Card` 加三个可选字段，`kind` 不塞进 `type`

```ts
/** 卡产品：借记（缺省）/ 信用。信用产品才有授信额度。 */
readonly kind?: 'debit' | 'credit'
/** 授信额度（分）；仅 kind='credit' 有意义。 */
readonly creditLimitCents?: number
/** 已用额度（分）；仅 kind='credit' 有意义。 */
readonly usedCreditCents?: number
```

**为什么不复用 `CardType`**：`type` 是**介质**（`physical` / `virtual`），与"借记/信用"正交。
把 `'credit'` 塞进 `type` 会让"虚拟信用卡"无法表达，并且要改既有 8 份 profile 的快照语义。

**为什么 `kind` 可选、缺省即借记**：老造数、老快照、老回放里的卡没有这个字段，
缺省解释成借记卡，`Object.keys` 不变，老载荷无需迁移（与 §2.5 的不变量同一口径）。

### 2.2 工具：扩参不新增工具名（目录仍是 30 个）

| 工具 | 新参数 | 规则 |
|---|---|---|
| `card_apply`（黄） | `kind?: 'debit' \| 'credit'`、`creditLimitYuan?: number` | `kind='credit'` 时额度必填；借记卡传了额度 → `tool-args-invalid` |
| `card_limit_set`（红） | `creditLimitYuan?: number` | 只有 `kind='credit'` 的卡接受；降额**不得低于已用**；与日/月限额可同时给，三项都校验 |

降额低于已用 → `credit-in-use`，文案必须说清"已用多少、最多能降到多少"——
只说"不合法"等于让用户自己猜（错误必须结构化且可读，AGENTS 编码纪律 5）。

**为什么不新开一个 `card_credit_limit_set`**：同一件业务动作（调整这张卡的额度）拆成两个工具，
模型就要先判"这张卡是借记还是信用"，判错就是另一个工具的错误码；
更糟的是工具目录上限（`BANK_TOOL_LIMIT`）是硬约束，用扩参能表达的动作不该占名额。

### 2.3 支付：授信额度是卡消费的**主约束**（本设计的核心）

`spendOnCard` 的校验顺序（顺序即安全边界，改动只新增一条，不重排既有判定）：

```text
卡存在且归属 → 状态 normal → online 限制 → category 限制
→ 【新增】授信额度（仅 kind='credit'） → 日/月限额 → 账户可用余额 → 记账
```

- 超额度抛 `credit-limit-exceeded`，`detail` 带 `creditLimitCents` / `usedCreditCents` / `neededCents`；
- **失败不占用**：所有失败都在记账之前抛出，`usedCreditCents` 一分不动（不是"扣了再退"）；
- **成功才占用**：`usedCreditCents += amountCents`，并写回卡对象（`this.cards = map(...)`）。
  `usedCreditCents` 是**账本事实**（与 `Card` 同处 append-only 账本），不再另算一份；
- **借记卡路径逐字不变**：`kind !== 'credit'` 时整段跳过，判定顺序、错误码、文案都不动。

**为什么授信额度排在日/月限额之前**：额度是信用产品的天花板，交易限额是叠加在它上面的
"防单日大额"附加约束。若先判日/月限额，"用了 1200、额度 5000、日限 5000、再刷 4000"
会先被日限额拒掉，用户拿到的理由是"超日限额"——而真正的拒绝原因是"超额度"。
**先判主约束，理由文案才对得上事实**。（借记卡不受影响：那条分支根本不进。）

**为什么信用卡的日/月限额缺省 = 授信额度**：信用产品的总额度已经封顶，缺省再套一个更小的
日/月限额只会让"额度内可用却刷不出去"，等于把额度做成假的。`card_limit_set` 调授信额度时
**不联动**日/月限额：两者语义不同，改一项就动另一项会让"我到底改了什么"变得不可解释；
开卡时的相等只是缺省值，不是耦合。

### 2.4 造数：demo 档多一张信用额度卡

`buildBankDataset(tier='demo')` 给张三加第三张卡：`c-3` / 尾号 `2468` / 虚拟 /
`kind='credit'` / 授信 5,000 元 / 已用 0 / 日限=月限=授信额度。

- 既有两张卡（`c-1` 实体借记、`c-2` 虚拟借记）**语义与字段逐字不变**；
- `stress` / `adversarial` / `recurring` 档不动（只按 `BankDataset.cards` 构造，不依赖 demo 的卡序）。

### 2.5 事件：**零新增键**，两个载荷加可选字段（改签，照 §3.4 格式）

| 键 | 追加字段 | 语义 |
|---|---|---|
| `card/issued` | `creditLimitCents?: number` | 本次签发的是信用产品时才有 |
| `card/limits-changed` | `creditLimitCents?: number`、`usedCreditCents?: number` | 变更后的授信额度与**变更时的**已用额度 |

- **不变量**：借记卡发射的事件形状与 v1.0.3 **完全一致**（`Object.keys` 不出现这两个键），
  老回放无需迁移；
- `usedCreditCents` 进事件的理由：额度调整的合法性取决于"已用多少"，事后只凭 `creditLimitCents`
  无法判断这次降额为什么被拒/被允；
- 键数不变（仍 36），不占事件表 §5 的改签名额——本 ADR 记在 `event-table.md` §3.5，
  与 §3.4 的 `approval/asked.details` 同型（可选增量、向下兼容）。

### 2.6 展示：必须能读出"额度 / 已用 / 可用"

1. `account_list` 的**正文**（模型与渠道卡片都读它）：信用产品多一段
   `授信额度 ¥5,000.00、已用 ¥0.00、可用 ¥5,000.00`；`CardView` 同时带
   `kind/creditLimitCents/usedCreditCents` 三个字段，供渠道自己排版；
2. `card_apply` / `card_limit_set` 的 `projectContent`：同一口径（"可用 = 额度 − 已用"），
   这三段金额由此统一改用 `formatYuan`（原先是 `(分/100).toFixed(2)`，同一句里会出现两种写法）；
3. `presentResult` 的 `bank.account-list` 卡片：`cards[]` 每行多一个
   `creditText = 额度 ¥x / 已用 ¥y / 可用 ¥z`（借记卡不带该字段，卡片数据形状不变）；
4. 审批明细（`approval-details.ts`）：信用产品补"当前授信额度 / 当前已用额度 / 本次调整为授信额度"。

**可用额度不落成模型字段**（`availableCreditCents`）：它是 `creditLimitCents - usedCreditCents`
的派生值，落第二份就会漂移。

> ⚠ 现实约束（不掩盖）：`UiCard` 目前**不落账**（`packages/channels/src/web/cards.ts` 的
> R-WEB-D6），Web 卡片是从 `tool/result.content` 的正文排版的。所以"用户真的看得到额度/已用/可用"
> 靠的是第 1 条的正文；第 3 条是给将来把 `UiCard` 落账时的现成数据。

### 2.7 离线路由：让"办信用卡"这句话能走通（`packages/llm/src/demo/router.ts`）

`parseCard` 原来把"额度"一律当**交易限额**，于是"办一张 5000 额度的信用卡"会落进调额分支，
再因为没有卡号变成"要调整哪张卡的额度？"——**用户想开卡，却拿到调额的追问**。
这条断链必须在同批修掉，否则功能只在工具面存在、演示面不存在。

改动三条，都刻意收窄：

1. **办信用卡**（信用词 + 办卡动词 + 无挂失/冻结）：`card_apply {kind:'credit', creditLimitYuan}`；
   额度没给就追问（工具面本来就开不出没额度的信用卡，路由不替模型编一个数）；
2. **调授信额度**（信用词 + 额度词）：投 `creditLimitYuan`；无信用词时仍投 `dailyLimitYuan`，
   与改动前**逐字一致**（`把尾号 1234 的卡日限额调到 500 元` 的既有断言不动）；
3. **卡号解析**加 `2468`/信用 → `c-3`，且信用优先于"虚拟"（`虚拟信用卡` 指的是 c-3）。

**不做的**：不接"用这张信用卡买束花"（与 ADR-0012 §3.5 同一条边界——卡消费通道没有路由演示），
也不做"把这张卡额度调到 3000"里的"这张卡"指代解析：路由是无状态确定性脚本，
指代要靠上下文，猜错就是把额度调到别人的卡上，宁可追问。

## 3 不声称（边界，逐条）

1. **不做还款 / 账单周期 / 最低还款 / 分期**：本设计只有"额度与占用"一条腿。
2. **信用卡仍从绑定账户扣款**（mock 收单沿用 ADR-0012 的记账路径），**不是真实透支**：
   本仓没有"欠款余额"这个账户维度，硬造一个会与账单口径打架。
3. **冲正不释放已用额度**：`spendOnCard` 只做占用。退款/冲正回补额度是下一单的事，
   本设计不假装有（回补做错比不做更糟：额度会被重复释放）。
4. **授信额度不约束以卡转账**：转账走 `transfer_preview` / `createTransfer` 的
   日/月限额与余额判定，没有"消费 vs 取现"的额度切分。额度只拦支付（`spendOnCard`）。
5. **不做跨卡合并额度、不做额度调高的征信/收入模型**：调额仍是红档（强验证 + 审批），
   被判定的只有"降额不得低于已用"这条硬约束。
6. **卡消费通道仍无独立路由演示**：沿用 ADR-0012 §3.5——`merchant_order` 是内部工具，
   路由不提供"用这张卡买束花"的话术。因此本设计的手工验收要按工具面走（见 §5）。
7. **`CreditLimitCents` 不参与 `cardLimitOf` 的日/月已用归集**：两套口径各自独立，
   不互相冒充（额度是授信口径，日/月已用是流水口径）。

## 4 后果

- 借记卡行为零变化：`kind` 缺省即借记，可选字段只在信用产品上出现；
- 工具数 **30 不变**（扩参不占名额，`BANK_TOOL_LIMIT` 仍 31）；事件键 **36 不变**；门禁数不变；
- 演示面：离线 demo 路由能演"办一张 5000 额度的信用卡 → 把尾号 2468 的信用卡额度调到 3000"
  （§2.7），不再把"办卡"错解成"调额"；
- 快照面：`Card` 结构新增可选字段 + demo 多一张卡 → `account_list` 的 `tool/result` 与
  正文会变（这是本设计**预期**的卡字段变化，不是行为漂移），重录后人工核对差异只落在卡字段与正文；
  ⚠ 本次重录还**吸收了工作树里已有的未提交漂移**（`bill_analyze` 的 month/year 参数、
  `callId` 的 `call-N:` 前缀、生日计划的草案文案）——它们不是本设计引入的，基线按实测为准；
- 负控（**已实测**，2026-11-01）：把 `spendOnCard` 里那行
  `if (usedCreditCents + req.amountCents > creditLimitCents)` 临时改成 `if (false)`，
  `mock.test.ts` / `account-ops.test.ts` / `mock.card-limits.test.ts` 三文件
  **3 例转红 / 111 例仍绿**，其中「刷 1200 成功；再刷 4000 被额度拒」失败成
  `expected 'card-daily-limit-exceeded' to be 'credit-limit-exceeded'`——正好证明
  "不判额度就会拿日限额顶包"（§2.3 那条排序理由的实际证据）；还原后 114 例全绿。

## 5 验收（工具面，不依赖演示路由）

```bash
npx tsc -b tsconfig.host.json tsconfig.client.json
pnpm test 2>&1 | tail -5
pnpm gate 2>&1 | tail -3
pnpm test:snapshot 2>&1 | tail -5
```

工具面链路（`createBankHarness()`）：

```text
card_apply {kind:'credit', creditLimitYuan:5000}      → 额度 500_000 分、已用 0
spendOnCard {card c-3, 1200 元}                        → 成功，usedCreditCents = 120_000
spendOnCard {card c-3, 4000 元}                        → credit-limit-exceeded，used 不变
card_limit_set {cardId:'c-3', creditLimitYuan:3000}     → 成功（高于已用 1200 元）
card_limit_set {cardId:'c-3', creditLimitYuan:1000}     → credit-in-use
card_apply {kind:'debit', creditLimitYuan:5000}        → tool-args-invalid
```

离线演示（`pnpm demo:web`，`packages/llm/src/demo/router.ts`）：

```text
办一张 5000 额度的信用卡                → card_apply {kind:'credit', creditLimitYuan:5000}
把尾号 2468 的信用卡额度调到 3000        → card_limit_set {cardId:'c-3', creditLimitYuan:3000}
```
