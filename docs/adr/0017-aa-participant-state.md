# ADR-0017 · AA 参与人状态机、到期收口与清算边界

- 状态：**已采纳**（2026-11-01）
- 关联：赛题场景 1（AA 拆分收款）、ADR-0011（AA 模拟代收）、
  `docs/contracts/event-table.md` §3 / §5、`packages/bank/src/core/{model,mock,provider}.ts`、
  `packages/bank/src/tools/{aa,governance,specs,result-schemas,events}.ts`、
  `packages/host/src/boot/plugins/{bank-tools,aa-expiry,saga-bridge}.ts`
- 影响面：AA 组模型、`aa_create` 动作面、到期 tick job `aa-expire`、Web 收款进度表

---

## 1 背景：AA 只有"两人态"，且没有截止时间

改动前：

```ts
export type AaParticipantStatus = 'pending' | 'paid'
export interface AaGroup { …; readonly createdAt: number }   // 没有 expiresAt
```

三个后果：

1. **没有"拒绝"**：参与人说不参加，系统只能保持 `pending`，收款进度永远停在"待收"；
2. **没有"过期"**：一笔 AA 组可以永远 `collecting`，组织者无法收口；
3. **清算边界只写在 ADR-0011 的文字里**：接口层没有任何"这不是跨人清算"的表达。

本单不假装能清算（那需要行内清算接口），只把"能做的部分"做扎实：
**参与人表态 → 状态可查 → 到期收口 → 账实对得上**。

## 2 决策

### 2.1 枚举扩到四态（`AaGroupStatus` 不动）

```ts
export type AaParticipantStatus = 'pending' | 'paid' | 'declined' | 'expired'
```

- `paid`：钱进来了（`in/transfer` 流水已写）；
- `declined`：明确拒绝；
- `expired`：到期未付 / 组织者提前结束。

`AaGroupStatus` 仍是 `'collecting' | 'completed' | 'cancelled'`：前端与既有快照都按三值消费，
扩它会波及无关面。

### 2.2 组增加可选截止时刻

```ts
export interface AaGroup {
  // …既有字段不动
  /** 收款截止时刻（epoch ms）；缺省 = 建组时 + 72h。 */
  readonly expiresAt?: number
}
export const AA_DEFAULT_EXPIRY_HOURS = 72
export const AA_MAX_EXPIRY_HOURS = 168
```

- 新组一律写 `expiresAt`；字段可选是为了兼容**本次改动之前**在内存里的组
  （它们没有截止时间，到期 job 跳过，不猜一个补上）。
- `create` 新增可选 `expiresInHours`（1–168，整数）；越界 `aa-invalid`。

### 2.3 动作扩展（不新增工具名）

`aa_create` 新增两个动作：

| 动作 | 定位 | 行为 |
|---|---|---|
| `decline` | `groupId` + `participant`（与 `collect` 同一套：姓名精确 / 0 基序号） | `pending → declined`；重复拒绝幂等（不改状态、不重复落事件） |
| `close` | `groupId` | 组织者提前结束：剩余 `pending` 全部转 `expired`，再按 §2.5 收口 |

两者都是**黄档写操作**，照常走审批票据；`decline` 的票面金额是 0（它不动钱）。
`status` 仍是唯一的只读分支（`READ_ONLY_ACTIONS` 不改）。

### 2.4 新增 1 个事件键

```ts
'aa/participant-updated': {
  readonly groupId: string
  readonly participantIndex: number
  readonly from: 'pending'
  readonly to: 'declined' | 'expired'
  readonly at: number
}
```

- **不复用 `aa/collected`**：那个键的语义是"钱进来了"，这里是"钱没进来"，
  混用会让对账无法区分"未付"与"已收"；
- **不加 `aa/expired` 第二个键**：`to` 已经表达了去向；
- 载荷只记账本事实（组号/序号/去向），不放姓名（PII 纪律同 `aa/collected`）；
- 发射点：`packages/bank/src/tools/aa.ts`（decline/close）与
  `packages/host/src/boot/plugins/aa-expiry.ts`（到期 job），均为
  `deps.audit.append('aa/participant-updated', …)` 字面量。

### 2.5 收口规则（唯一实现：`settleAaGroup`）

| 触发 | 结果 |
|---|---|
| 全员 `paid` | 组 `completed` |
| 有人 `declined` 但其余仍 `pending` | 组保持 `collecting`（不因一个人拒绝就散组） |
| `close` 或到期 | 剩余 `pending → expired`；`paid > 0` → `completed`，否则 `cancelled` |
| 最后一位 `pending` 被拒绝 | 有 `paid` → `completed`，无 `paid` → `cancelled` |
| 对同一人重复 `collect`（组仍 `collecting`） | 返回 `aa-participant-paid`（结构化幂等错误），**不重复入账** |
| 组 `completed` 后对已 `paid` 的人重复 `collect` | **同为 `aa-participant-paid`**（复审 P1-3：两次重复不该有两种理由码） |
| 已 `declined/expired` 的人被 `collect` | `aa-participant-closed`，不改状态 |
| 已过截止时间但 job 尚未运行 | `aa-group-closed`，**不改状态、不入账**（复审 P1-2） |

`settleAaGroup` 是**私有唯一实现**，`collect` / `decline` / `close` / 到期四处调用它。
三处各写一份判定，必然出现"close 说 completed、到期说 cancelled"的对账事故。

> 重复 `collect` 为什么不是"返回首次结果"：`AaCollectResult` 必须带 `txnId`，
> 而首次入账的流水不属于本次调用；凭记忆返回一个旧 `txnId` 等于伪造凭证。
> 保持结构化错误（`aa-participant-paid`）同时满足"不重复入账"，且审计上分得清
> "这次没执行"与"执行成功"。

### 2.6 到期 job：`aa-expire`

- 注册在 `packages/host/src/boot/plugins/aa-expiry.ts`，由 `bank:tools` 装配时注册；
- 时钟源复用 `saga/tick`（与 janitor / recon / plan-wake / sub-reminder 同一个），
  不另起 interval；常驻 profile（`web` / `mobile` / `web-plan`）的 saga-bridge 是
  **tick-only**（`eligible: []`，每 60s 派发），批次型 `plan` 仍关闭 saga-bridge，
  启动时补跑一次，与 `plan:scheduler` 同法；
- 扫描条件：`status === 'collecting' && expiresAt !== undefined && expiresAt < at`
  （**严格小于**：恰好等于截止时刻仍可代收，边界写进测试）；
- **代收入口同判**（复审 P1-2）：`collectAa` 在记账前判 `expiresAt < now`，过期即抛
  `aa-group-closed`。到期 job 只是"把组收口"的动作，不定义"窗口还在不在"——job 没跑
  不等于还能收钱。票前预览（`checkAaParticipant`）用同一条件，避免先批后拒；
- 幂等两层：
  1. **状态机**：收口后组不再是 `collecting`，下一次扫描自然跳过；
  2. **组级账本**：job 内 `Set<groupId>`，同一 tick 周期内重入/并发只处理一组一次；
- 账本在内存、不 durable：core 本身不重放 AA 组，重启后组不存在，无需持久化。

### 2.7 展示口径

- `pendingCents` 改为**只统计 `pending` 的份额**。从前是"总额 − 已收"，有了
  `declined/expired` 之后那个算法会把"钱不会进来"的份额算成待收，看起来像还有希望。
- Web 的"收款进度"表新增状态列（待收 / 已收 / 已拒绝 / 已过期），
  `aa/participant-updated` 推进同一张表；缺这一步，`declined` 会显示成"待收"。

### 2.8 票据核销边界（复审 P2-4，登记为例外）

`aa_create` 的写动作（`create` / `collect` / `decline` / `close`）都经过治理面的审批与票据签发，
但工具体**没有**调用 `ticketRefForCall` 去核销票据。同样的情况存在于既有的 `card_limit_set`
（02 单），不是 05 新引入。

后果：`tools/result` 的记账把"已批准、未核销"的票据记为 `blocked(not-redeemed)`——
审计上看起来像"批准了却没执行"。

本轮不补齐的理由：`collect` 的票面金额等于参与人份额，补核销要在工具体里重新定位参与人；
而治理面的票前预览已经有一份定位/金额逻辑，再写一份就是第三个真相源。正确做法是
"工具层统一 `ticketRefForCall` + 金额解析"一次改完，属独立批次。答辩口径：AA 写动作
**有审批、有票据签发**；票据核销账本与工具体目前未闭环，不声称"票据全链路已核销"。

## 3 清算边界（原文照抄，不许改写）

> 「`collect` 是账本内代收：本进程替参与人把份额记进组织者活期并写一条 `in/transfer` 流水。
> 它不是跨人清算，也不能作为第三方付款证明。真实收款需要行内清算接口。」

三条补充：

1. `collect` 的入账发生在**组织者自己的账户**，没有任何行内清算报文；
2. 组里其他参与人的账户不会被扣款，本仓没有他们的账户访问权；
3. `paid` 只表示"本进程替这位参与人记了一笔账"，**不是**"这位参与人已向组织者付款"的证明。

## 4 明确不做

- 不做真实清算、不做跨行/跨人扣款、不接清算接口；
- 不改 `AaGroupStatus` 的三个值；
- 不加第二个 AA 事件键；
- 不把 `expiresInHours` 做成"每用户配置"（赛题没要求，配置面每加一键门禁就多验一处）；
- `decline` 不引入"票据以外的额外授权"——它就是黄档写操作。

## 5 验收

- 核心：四态迁移、边界（`expiresAt` 严格小于）、收口三处同源、入账合计 == Σ`paid` 份额；
  `expiresAt` 已过但 job 未跑时 `collect` 当场拒绝且状态仍为 `collecting`；completed 组重复
  `collect` 与 collecting 同码 `aa-participant-paid`；
- 工具：`decline` / `close` 各落一条/多条 `aa/participant-updated`；重复 `collect` 不重复入账；
  票前预览对"过期"与"completed 重复"给出与执行期相同的码；
- 到期 job：注入钟推进到 `expiresAt + 1` 自动收口，且只收口一次；
- 门禁：`pnpm gate`、`pnpm test`、`pnpm test:snapshot`、`tsc -b` 全绿。
