# ADR-0016 · 通用主动通知通道（`bah:proactive`）与订阅续费主动提醒

- 状态：**已采纳**（2026-11-01）
- 关联：赛题场景 5（订阅/代扣）、本设计、生日主动检测（**复用本通道**）、
  `docs/contracts/event-table.md` §3 / §5、ADR-0007（订阅域事件）、ADR-0012（卡限额）、
  `packages/runtime/src/notify/policy.ts`（打扰预算）
- 影响面：`packages/host/src/boot/plugins/{proactive,bank-tools,index,saga-bridge}.ts`、
  `packages/channels/src/web/{proactive,project,index}.ts`、
  `packages/bank/src/tools/events.ts`、`packages/saga/src/{tick/registry,seams}.ts`、
  `profiles/{web,mobile,web-plan,plan,im,desktop}/patch.yml`

---

## 1 背景：缺的不是"判断该不该提醒"，是"投递路径"

| 已有的 | 缺的 |
|---|---|
| `detect/recurring.ts` 周期检测（纯函数、180 天窗口） | 用户不问就永远不会被提醒 |
| `sub_watch(watch='remind', aheadDays)` 标记 | 标记只是数据，没有任何东西读它 |
| `deriveNotify()` 打扰预算（静默/日上限/同档间隔/去重） | 只有 `plan_wake` 一处在用，且结果只进返回值 |
| web 的 `NoticeFrame` | 只在回合结束时产生（用户必须先在对话里做点什么） |

本设计要补的就是最后一段：**从"扫描"到"用户看见"的一条路径**，而且这条路径要能被
04（生日）、安全告警复用——所以通道叫 `proactive/*`，不叫 `sub/*`。

## 2 决策

### 2.1 服务接口（**后续能力复用这一份，不要另造**）

```ts
/** 服务键：`bah:proactive`（`packages/host/src/boot/plugins/proactive.ts`）。 */
export interface ProactiveService {
  push(candidate: ProactiveCandidate): Promise<ProactiveDelivery>
}

export interface ProactiveCandidate {
  /** 提醒来源。取值域在**入参**上收紧；事件载荷里是 `string`（见 §2.5）。 */
  readonly source: 'subscription' | 'birthday' | 'plan' | 'safety'
  /** 幂等键：同一 key 在进程内只发一次。键的**粒度**决定"多久算同一件事"。 */
  readonly key: string
  readonly priority: 'exec' | 'decision' | 'alert'
  /** 判定时刻（注入钟）。 */
  readonly at: number
  /** 用户能看到的整句话（金额与日期都在里面）。 */
  readonly title: string
  /** 更长的说明（可选）。本设计**不渲染**：事件契约里没有它，见 §2.5。 */
  readonly text?: string
  /** 可读级别（可选）。同上：事件里没有 `level`，帧不按它上色。 */
  readonly level?: 'info' | 'success' | 'warning' | 'danger'
}

export interface ProactiveDelivery {
  readonly sent: boolean
  /** `im` 目前恒为 `none`（没有 IM 主动出口，见 §5）。 */
  readonly channel: 'in-app' | 'im' | 'none'
  /** `ok` / `quiet-hours` / `daily-cap` / `low-priority` / `dedup` / `not-ready`。 */
  readonly reason: string
}

export const PROACTIVE_SERVICE = defineService<ProactiveService>('bah:proactive')
```

**`reason` 为什么是 `string` 而不是封闭联合**：`deriveNotify` 的理由码将来会扩充
（例如 04 可能加 `birthday-quiet` 一类的策略），把它钉死在公共接口上等于每加一条
理由都要改 04 的类型。取值域写在 `deriveNotify` 的 `NotifyReason` 上，一处收紧。

### 2.2 投递链路：一条，不新增第二条写帧路径

```text
saga/tick('sub-reminder') 或 boot 补跑
  → scanOnce：bank:subscription-probe（只读取数，权威口径在 core）
  → reminderCandidatesOf（纯函数：该发哪几条）
  → PROACTIVE_SERVICE.push → deriveNotify(DEFAULT_NOTIFY_BUDGET) 判预算
  → BANK_AUDIT.append('proactive/reminder', …)   ← 唯一的落账点
  → channel:web 的 session/event → WebProjector → SseHub.publish(frame)
  → 页面收到 `notice` 帧（不提问也看得见；刷新后由快照重放）
```

**与任务书 §3.3 的偏差（明写）**：任务书写的是"拿到当前会话的 hub → 推 `NoticeFrame`"。
实现改成"落事件 → 投影器产帧"，三个理由：

1. **hub 不是服务**：`SseHub` 是 `createHttpChannel` 的局部变量，`WEB_SERVER` 只带
   `port/url/sessionId`。外部插件要拿到它，只能新开一个 `publish` 端口——那就是
   **第二条写帧路径**，而 `web/sse.ts` 头注释把"再开一处 `res.write`"列为拆 handler
   时的头号坑（"心跳与快照会绕过注销逻辑"）。
2. **刷新即丢**：直接推 hub 的帧不进 `session.jsonl`，用户刷新页面就再也看不到
   （快照只由事件重放）。"提醒"应当是可回放的。
3. **序（`seq`）**：`notice:<seq>` 是前端稳定键。事件自带 `seq`，推的帧只能编一个——
   编出来的号要么撞车要么乱序。

帧仍然是既有 `notice`（**没有新帧 kind**），前端零改动。

### 2.3 提醒规则（写死在代码里，不进配置）

| 情形 | 行为 |
|---|---|
| `reminderAheadDays` 已设且 `剩余天数 ≤ aheadDays` | 逐条提醒，key `sub:<id>:<dueAt 的 YYYY-MM>`，`priority='decision'` |
| 未设 remind 但 7 天内扣款 | **每天最多 1 条**汇总，key `sub:digest:<YYYY-MM-DD>`，`priority='exec'`，列前 3 笔 |
| `note='idle'`（用户说过"我不用了"） | 不提醒（两条路径都排除） |
| 已取消 / 已暂停 / 已断供 | 不提醒（`upcomingCharges` 只回 `active`，生成候选时再兜一次） |
| 静默时段（`deriveNotify` 判 `quiet-hours`） | **不落"已发"标记**，下一个 tick 再试 |

**`decision` vs `exec` 的取舍**：用户自己要求过的提醒用 `decision`——静默时段不推，
但**没有**同档最小间隔，几张订阅同日到期能逐条出去；汇总用最低档 `exec`——它本来就
可以"攒到下一条一起说"，5 分钟间隔与日上限都该拦它。

**配置只留两键**（`enabled` / `catchUpOnBoot`）：窗口天数、每日上限、静默时段、
汇总条数都是**规则**，不是部署参数——写进配置就会有人调，调了就没有可解释的口径。

### 2.4 两张内存账本（都不 durable）

| 账本 | 类型 | 用途 |
|---|---|---|
| `sentAt` | `Map<key, at>` | 同 key 只发一次。**不持久化**：重启后重复一次可接受，"永久不发"才是危险的那一边 |
| `suppressedLogged` | `Set<«key»@«日期»>` | 同一条被压掉的提醒**每天只记一条审计**（否则静默 8 小时 × 每 30 秒一个 tick = 一个上午近千条噪音） |

**`dedup` 不落事件**：`deriveNotify` 的 5 分钟去重窗口说明"同 key 刚发过"，
再落一条"没发"的事件没有任何信息增量。

### 2.5 事件：新增 1 个键（代码口径 36 → **37**，非任务书写的 23 → 24）

```ts
'proactive/reminder': {
  readonly source: string
  readonly key: string
  readonly title: string
  readonly channel: 'in-app' | 'im' | 'none'
  readonly suppressedReason?: string
  readonly at: number
}
```

- **键名不是 `sub/reminder-due`**：生日提醒要用同一条通道，泛化名字才不需要二次改签；
- **`source` 是 `string`**：新的主动能力不该因为"要发一条提醒"而改事件类型；
- **`text` 与 `level` 不进事件**：所以 §2.1 的 `text` / `level` 在本设计**不被渲染**——
  实时推 `text`、回放只剩 `title`，同一件事就有两个样子。要渲染先改契约（另开 ADR）；
- **`suppressedReason` 必须与 `channel='none'` 同时落**：否则回放只看到"没提醒"，
  看不到"为什么没提醒"（夜里被静默正是最需要可解释的那一种）；
- 事件表 `v1.0.3 → v1.0.4`，§5 记一次改签。

### 2.6 tick 与 boot 补跑

- **tick**：`registerTickJob('sub-reminder', …)`，与 janitor / recon / anchor / plan-wake
  共用 `saga/tick` 这**一个**时钟源（`packages/saga` 的 `TickJobName` 与 `seams.ts` 的
  `dueJobs` 联合各加一项；`bank:saga-bridge` 的派发数组同步加一项）。
- **boot 补跑**：`catchUpOnBoot` 打开后，等 `bank:tools` 的服务就绪（20 × 50ms 重试，
  同 `plan:scheduler`）再扫一次。

**为什么补跑也要扫汇总**（不是"只补明确提醒"）：`profiles/web` / `mobile` / `web-plan`
的 `bank:saga-bridge` 是 **tick-only**（`eligible: []`：不接管工具，避免
`transfer_create` 双层展开），`saga/tick` 每 60s 派发一次，到期 job 会周期性运行。
boot 补跑仍保留：否则"打开页面到第一个 tick 之间"有最长 60s 的空窗，演示会以为没提醒。
`profiles/plan` 是批次型入口，仍关闭 saga-bridge，只靠 boot 补跑（已在
`packages/host/src/boot/plugins/resident-tick.test.ts` 钉住这一差异）。代价（已知）：
每次进程启动按当天规则扫一遍，同一天重启会重发一次（内存账本，见 §2.4）。

**幂等键取扣款月（复审 P1-4）**：`monthKeyOf` 的入参是 `charge.dueAt`，不是判定时刻 `at`。
用 `at` 时，3 月 30 日提醒 4 月 1 日的扣款得到 `…:2026-03`，4 月 1 日再 tick 得到
`…:2026-04`，同一笔扣款被提醒两次；改用 `dueAt` 后两个 tick 命中同一个 key。

### 2.7 profile 接线

| profile | 是否装配 | 理由 |
|---|---|---|
| `web` / `mobile` / `web-plan` / `plan` | ✅ `config: { enabled: true, catchUpOnBoot: true }` | web/mobile/web-plan 是常驻进程（saga-bridge tick-only，每 60s 派发）；plan 是批次型入口，靠 boot 补跑 |
| `im` | ❌ | `apps/im-gateway` 只有"收到消息 → 回消息"，**没有服务端主动外呼**的通道；写开关=摆设 |
| `desktop` | ❌（留 TODO） | 与 web 共用 host 但独立 profile；桌面窗口生命周期未复核，先不加，避免"打开就弹一条没人看的提醒" |

## 3 不声称（边界，逐条）

1. **IM 主动消息未接**：`channel` 只可能是 `in-app` 或 `none`；要接得先有 IM 侧机器人
   主动发消息的 API（飞书/企微），本仓没有，不伪造。
2. **账本不持久化**：重启后同一天可能重发一次（尤其 `catchUpOnBoot`）。可解释、可接受；
   反过来"进程重启就永远不提醒"是不可接受的。
3. **只服务单会话**：宿主是"一应用一会话"，扫描只针对 `run.sessionId` 解析出的那一个
   用户。多用户/多租户的主动推送需要"按人遍历"的编排，本设计不做。
4. **`idle` 用 `note` 判定**：`sub_watch(watch='idle')` 写的是 `note='idle'`；
   `hesitating`（还在犹豫）**照常提醒**——犹豫不等于不要。
5. **不重算周期**：下次扣款日只来自 `core.upcomingCharges`（它复用 `Subscription.nextChargeAt`
   与 `detect/recurring.ts` 的推断），插件里没有任何周期算法。
6. **时区固定 UTC+8**：静默时段（`deriveNotify`）与"几天后"的日历换算共用同一口径；
   换时区要连同打扰预算一起改，本设计不做。
7. **到期日刚过（`dueAt < at`）的不提醒**：那是"漏了"而不是"即将"，补发一条过期提醒
   只会让用户点开一个已经扣完的账。
8. **`text` / `level` 暂不渲染**（§2.5 理由）；04 若要富文本，先改事件契约。

## 4 后果

- 事件键 **36 → 37**（`BANK_SESSION_EVENT_TYPES` 与 `event-table.md` 同批）；
- 工具数不变（**30**）、门禁数不变（**54**）、`BANK_TOOL_LIMIT` 仍 31；
- `packages/saga` 的 tick 联合多一项（`sub-reminder`）：类型面 +1、派发面 +1，行为面不变
  （没登记 job 时 `runTickJob` 静默跳过）；
- 快照面：`profiles/plan` 多了本插件的行 → `plan` / `proactive` / `cross-scene` 三个场景的
  `rows` 变；且在固定钟（06:13 UTC+8）下 boot 扫描会被静默时段压掉，多落**一条**
  `proactive/reminder(channel='none', suppressedReason='quiet-hours')`——这是**预期**变化
  （证明"夜里不吵，但审计看得见"），重录时逐个核对；
- 新增快照场景 `snapshots/subscription-reminder/`：明确要求过提醒的订阅 → 时钟推进 →
  tick → 一条 `in-app` 提醒（帧级可回放）。

## 5 验收

```bash
npx tsc -b tsconfig.host.json tsconfig.client.json
pnpm test 2>&1 | tail -5
pnpm gate 2>&1 | tail -3
pnpm test:snapshot 2>&1 | tail -5
```

手工（`pnpm demo:web`）：进程启动即扫一次（web profile 的 `saga/tick` 每 60s 派发，
boot 补跑只是让首个周期不空窗），**不提问**也应看到一条「未来 7 天 N 笔自动续费：…」
的 notice；刷新页面由快照重放，不重复堆叠。

## 6 扩展点：生日主动检测（2026-11-01 已落地）

本设计建通道时预埋的 `source: 'birthday'` 在这一节被真正消费。**零新增事件键**：
生日提醒复用 `proactive/reminder`，`source='birthday'`。

### 6.1 数据源：已有事实库，不另造画像

- 来源：`packages/runtime/src/fact/` 的 `LifeFact`（结构化字段 `kind='birthday'` + `date`）；
- 用户说"记住我爱人生日 3 月 8 日" → 模型写 `kind='birthday', date='YYYY-MM-DD'`；
- **不改 `Fact` 存储结构**，也不引入自由文本约定格式（那会让既有事实失效）。

### 6.2 规则（写死在 `birthday.ts`，不进配置）

| 规则 | 值 |
|---|---|
| 提前量 | **3 天**（`BIRTHDAY_AHEAD_DAYS`；含当天，0–3 天都提醒） |
| 触发 | `birthday-reminder` tick job（与 `sub-reminder` 同一个 `saga/tick` 时钟源） |
| 与任务书 04 §3 的冲突 | 任务书写"`aheadDays` 可被 `proactive:reminder` 的 config 覆盖"；本仓**选择固定 3 天**，与本通道"规则不进配置"（§2.3 / §2.6）一致。冲突登记在这里，对外说明按本 ADR 口径回答 |
| 幂等 | `birthday:<factId>:<目标年份>`——同一生日一年只提醒一次 |
| 闰日 | 2 月 29 日在平年按 **3 月 1 日**（`Date.UTC` 的自然滚动，不另写分支） |
| 脏数据 | 缺日期 / 非 `YYYY-MM-DD` / 不存在的日期 → **静默跳过**，不抛错 |
| 已 `fact_forget` | 不提醒（账本里已经没有这条事实） |

### 6.3 接线

- 扫描器：`packages/host/src/boot/plugins/birthday.ts`（`birthdayCandidatesOf` 纯函数 +
  `scanBirthdays` 投递）；
- 注册点：`proactive:reminder` 插件里的**第二个** tick job `birthday-reminder`。
  不新开插件——两个插件各建一条投递路径就是分叉；
- boot 补跑：`web` / `mobile` / `web-plan` 的 tick-only saga-bridge 每 60s 派发，
  启动时仍与订阅补跑并列再跑一次生日扫描（不让第一个 tick 周期成为空窗）；
- saga 面：`TickJobName` / `seams.ts` / `saga-bridge` 派发数组各加一项。

### 6.4 明确不做

- 不做"每用户可配提前量"（赛题没要求，配置面每加一键门禁就多验一处）；
- 不渲染 `text` / `level`（事件契约里没有，见 §2.5）；
- 不新建第二条推送路径。

### 6.5 验证

- `packages/host/src/boot/plugins/birthday.test.ts`：3 天命中 / 4 天不命中 / 同日幂等 /
  当天不重复 / 脏事实跳过 / forget 后不提醒 / 闰日 / 跨年；
- 快照 `snapshots/birthday-reminder/`：记事实 → 推钟到 3 月 5 日 → tick → 一条
  `proactive/reminder(source='birthday')`；再 tick 不重复，回放成 `notice` 帧。
- 路由："给爱人订生日计划"落到 `birthday/propose`（`packages/llm/src/demo/router.ts`）。
