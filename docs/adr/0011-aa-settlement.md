# ADR-0011 · AA 收口：只读分支 + 模拟代收

- 状态：**已采纳**（2026-11-01）
- 关联：`docs/contracts/event-table.md` §5
- 影响面：`packages/bank/src/core/{provider,mock,model}.ts`、
  `packages/bank/src/tools/{specs,tier,governance,aa,events,dto}.ts`、
  `docs/{bank-tools,contracts/event-table}.md`

---

## 1 背景

AA 拆分收款此前只完成了一半：

1. **B-04**：`aa_create` 是动作式工具，但 `spec.event` 只有 `aa/created`；
   `action="status"` 实际落 `read/aa` 却没有声明 `readEvent`，且查询分支仍按黄档签票——
   **读一次 AA 状态要用户批一次**。
2. **B-05**：AA 只生成"每人待收多少"，`AaParticipantStatus` 永远停在 `pending`，
   没有任何入账/代收路径；`paidAt` 字段在模型、DTO 与出参 schema 里都已声明，
   但**没有写入方**（死字段）。

## 2 决策

### 2.1 `status` 成为绿档只读（与 `risk_assess(action="questions")` 完全同构）

```ts
// packages/bank/src/tools/tier.ts
READ_ONLY_ACTIONS = [
  { name: 'risk_assess', action: 'questions' },
  { name: 'aa_create', action: 'status' },   // 新增
]
```

- `specs.ts`：`aa_create` 加 `readEvent: 'read/aa'`；
- `decide()` 在**身份闸之后**直接返回 `{ kind:'allow', level:'green', reason:'declared' }`；
  `governance.ts` 用同一个 `isReadOnlyAction`，不另写一份"哪些 action 是只读"；
- `create` / `collect` 不在表里，照常 `ask`（黄档签票）。

四条约束（沿用 ADR-0009 的同一组）：

1. 封闭表：动作值只来自这张表，不从 `args` 里猜；
2. 只读验证：`status` 分支确实不写库（只 `getAa` + 落 `read/aa` 审计）；
3. 审计留痕：判决落 `tier/decided`（`green/declared`）；
4. 不许工具内自判：`aa.ts` 不含任何级别阈值。

### 2.2 模拟代收（demo 口径）

`BankCoreProvider` 新增：

```ts
collectAa(req: { userId, groupId, participant: number | string }): Promise<{
  group; participantIndex; collectedCents; txnId
}>
```

`participant` 只接受**姓名或序号（0 起）**，**不收手机号**：手机号既是 PII，
又会在同组同名/改号时变成第二真相源。工具层把 `"0"`/`"1"` 这类纯数字串解析成序号。

固定校验顺序（顺序即安全边界）：

```text
组归属 → 组 collecting → 未过 expiresAt → 参与人存在 → 参与人未付过 → 记账
```

- 组归属：不存在/非本人 → `aa-unknown`（与 `getAa` 同码，不泄露他人组的存在性）；
- 组状态：`completed` / `cancelled` → `aa-group-closed`；**例外**：`completed` 组对已付
  参与人的重复 collect 返回 `aa-participant-paid`（ADR-0017 §2.5；
- 截止时间：`expiresAt < now` → `aa-group-closed`，不等到期 job 先跑（ADR-0017 §2.6；
- 参与人：同名多位 → `aa-participant-ambiguous`（必须改用序号）；找不到/序号越界 →
  `aa-participant-unknown`；
- 已付 → `aa-participant-paid`（幂等错误，**不重复入账**）；
- 记账：组织者**主账户**（`listAccounts` 排序后的第一张，不另建"主账户"字段）
  `+share`，写一条 `in / transfer` 流水，`counterparty.memo = "AA 代收：<标题>"`；
- 更新参与人 `status='paid'` / `paidAt`；全部 `paid` ⇒ 组 `completed`。

任一步失败都在记账之前抛：账本与组状态都不变（用户修正后可重试）。

### 2.3 票据金额 = 该参与人份额

`collect` 是黄档写操作。若只按 `spec.amountPath`（AA 没有金额参数），审批卡就只剩
一个没有金额的"执行 aa_create"——用户批准的东西与真正入账金额对不上。

`governance.ts` 在签票前做一次**只读预览**（`checkAaCollect`：`getAa` + 定位 + 取份额），
把金额写进 `approval/asked.amount` 与票据金额。执行期 `core.collectAa` 仍按完整五道顺序
再判一次（预览与执行分开是既有模式，transfer preview 同样先算一次）。

### 2.4 事件

新增 `aa/collected`（键数 33 → **34**）：

```ts
'aa/collected': {
  groupId; participantIndex; collectedCents; txnId; at
}
```

- 只放**账本事实**：哪一组、第几位、入账多少、对应流水；
- **不放姓名/手机号**：姓名已在组快照（`aa/created` 的 `result`）里，重复落账只会多一处
  需要清理的 PII；
- `read/aa` 保留（`status` 分支的审计事件）。

一个工具体有两个写事件（`aa/created` / `aa/collected`），`spec.event` 只记 `aa/created`
（目录门禁按单一 `event` 渲染）；`aa/collected` 在本 ADR 与 `docs/bank-tools.md` 事件表登记。

### 2.5 PII

- `AaParticipantView` **仍然没有 `phone`**（`aa/created` 的 `result` 也不带）；
- `aa/collected` 载荷不含姓名；
- 参与人定位不收手机号（传手机号 → `aa-participant-unknown`，不会被当成键）。

## 3 不声称（对外说明时必须说清）

1. **不是真实到账**：`collect` 是 demo 模拟代收——本进程替参与人把那一份"记进"
   组织者主账户并写流水；跨人真实收款需要行内清算接口，本仓没有。
2. **不是第三方付款证明**：`collect` 是组织者对自己发起组的模拟结算，
   服务端无法区分"真的收到钱"与"组织者点了代收"。
3. **票据金额是预览值**：批准后组状态/参与人状态可能已变，执行期 `core` 会再判，
   失败需要重新批准（不是"一次批准永久有效"）。
4. **"主账户"是排序口径**：`listAccounts` 按账户 ID 排序后的第一张，
   不是产品定义的"主账户"（账户模型里没有这个字段）。
5. **同名多位必须用序号**：没有做"同名自动消歧"或"参与人改名/合并"。
6. **`paidAt` 是代收时刻**，不是真实到账时刻。

## 4 后果

- 正向：场景 1「拆分 AA 收款」可演示到**账本内入账**（余额、流水、组状态都能对账）；
- 正向：`status` 不再签票，AA 查询从"每次批一次"变成零票据；
- 正向：`paidAt` 从死字段变成有写入方的真实状态；
- 负向：`collect` 的票据金额是预览值，组状态变化会让执行期拒绝（用户需重新批准）；
- 中性：工具数不变（仍 28），事件键 33 → 34；
- 中性：演示路由（`parseAa` 的 status/collect 话术）未做（可选项），
  当前只能由工具面/模型直接调用。
