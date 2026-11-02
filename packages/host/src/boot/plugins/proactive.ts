/**
 * `proactive:reminder`：订阅续费主动提醒（ADR-0016）。
 *
 * ## 本插件要解决的两件事
 *
 * 1. **把"查询时派生"的提醒变成主动推送**：`sub_watch(watch='remind', aheadDays)` 过去
 *    只是给订阅打一个标记，用户不主动问就永远看不到；提醒必须自己找到用户。
 * 2. **建一条通用主动通知通道**（`bah:proactive`）：键名刻意是 `proactive/*` 而不是
 *    `sub/*`——生日、计划、安全告警都要复用同一条通道，否则每种能力各造一条推送路径，
 *    最终口径必然分叉。
 *
 * ## 投递链路（一条，不新增第二条）
 *
 * ```text
 * saga/tick（或 boot 补跑）→ scan → PROACTIVE_SERVICE.push
 *   → deriveNotify 预算（静默时段 / 日上限 / 同档间隔 / 去重）
 *   → BANK_AUDIT.append('proactive/reminder', …) 落账
 *   → 渠道把该事件投影成 `notice` 帧经既有 SSE 推给页面
 * ```
 *
 * **为什么"落账"就是"投递"**：`UiCard` 不落账（R-WEB-D6），而主动提醒没有 `tool/call`
 * 作承载点。把结论落成领域事件，`session/event → WebProjector → SseHub` 这条既有管线
 * 就同时解决了"实时推"与"刷新/回放仍在"——不要在插件里另开一条 `hub.publish` 旁路，
 * 那会绕过帧投影器（第二条写帧路径，`sse.ts` 头注释点名禁止的坑）。
 *
 * ## 三条纪律（对应）
 *
 * - 提醒规则写死在代码里，**不进配置**：配置只留 `enabled` / `catchUpOnBoot`；
 * - 预算不可绕过：一律过 `deriveNotify`。"主动"不等于"想发就发"；
 * - 幂等账本在内存（`Map<key, at>`），**不 durable**：重启后重复一次可接受，
 *   "永久不发"才是危险的那一边。
 */

import { defineService, type ServiceKey } from '@bah/core'
import { BANK_IDENTITY, formatYuan, type BankAudit, type UpcomingCharge } from '@bah/bank'
import { DEFAULT_NOTIFY_BUDGET, deriveNotify, SESSION_SERVICE, type NotifyHistoryItem } from '@bah/runtime'
import { registerTickJob } from '@bah/saga'
import { logJson } from '@bah/util'

import type { SessionId } from '@bah/core'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { readBoolean, rejectUnknownKeys } from '../config.ts'
import {
  BANK_AUDIT,
  BANK_SUBSCRIPTION_PROBE,
  type SubscriptionProbe,
} from './bank-tools.ts'
import { scanBirthdays, type BirthdayScanDeps } from './birthday.ts'
import { FACT_SERVICE } from './fact.ts'

/** 主动提醒的来源（**服务入参**的封闭联合；事件载荷故意是 `string`，见 events.ts）。 */
export type ProactiveSource = 'subscription' | 'birthday' | 'plan' | 'safety'

/** 一条待投递的主动提醒。 */
export interface ProactiveCandidate {
  readonly source: ProactiveSource
  /**
   * 幂等键：同一 key 在进程内只发一次。
   *
   * 键的**粒度**决定"多久算同一件事"：订阅提醒用 `sub:<id>:<YYYY-MM>`（每月一次）、
   * 汇总用 `sub:digest:<YYYY-MM-DD>`（每天一次）。服务不猜时间窗，只保证"同 key 不重复"。
   */
  readonly key: string
  readonly priority: 'exec' | 'decision' | 'alert'
  /** 判定时刻（注入钟；不许用 `Date.now()`）。 */
  readonly at: number
  /** 用户能看到的**整句话**（金额与日期都在里面）。 */
  readonly title: string
  /**
   * 更长的说明（可选）。
   *
   * ⚠ 本设计**不渲染**它：事件契约 `proactive/reminder` 冻结的字段里没有 `text`，
   * 而帧由事件投影而来——若实时推 `text`、回放只剩 `title`，同一件事会有两个样子。
   * 保留字段是给留的：等 `text` 进契约（另开 ADR）时再一起渲染。
   */
  readonly text?: string
  /**
   * 可读级别（可选）。
   *
   * ⚠ 同上：事件里没有 `level`，帧也不按它上色。留着是给 04 的分级提示词用；
   * 真要影响界面颜色，先改事件契约。
   */
  readonly level?: 'info' | 'success' | 'warning' | 'danger'
}

/** 一次投递的结论（调用方据此决定要不要重试/换文案）。 */
export interface ProactiveDelivery {
  readonly sent: boolean
  readonly channel: 'in-app' | 'im' | 'none'
  readonly reason: string
}

/**
 * 通用主动通知通道（照抄这个接口，**不要**另造一套）。
 *
 * 唯一的实现是 `createProactiveService`：预算判定 + 幂等账本 + 落账三件事都在里面，
 * 调用方只负责"说什么"，不负责"要不要说"。
 */
export interface ProactiveService {
  push(candidate: ProactiveCandidate): Promise<ProactiveDelivery>
}

/** 服务键：`bah:proactive`。 */
export const PROACTIVE_SERVICE: ServiceKey<ProactiveService> = defineService<ProactiveService>(
  'bah:proactive',
)

/** `proactive:reminder` 的配置（提醒规则不在这里，别往里加阈值）。 */
export interface ProactiveSettings {
  /** 总开关：关掉即不注册 tick job、不做 boot 补跑、不提供服务。 */
  readonly enabled: boolean
  /** 启动时是否立即补跑一次完整扫描（有 tick 也保留：不让第一个 tick 周期成为提醒空窗）。 */
  readonly catchUpOnBoot: boolean
}

export const DEFAULT_PROACTIVE: ProactiveSettings = { enabled: true, catchUpOnBoot: true }

const WHERE = 'proactive:reminder'

/** 汇总窗口（天）：未标 remind 但 7 天内扣款的，合并成一条。 */
const DIGEST_WINDOW_DAYS = 7

/** 汇总里最多列几条（多了是噪音，用户要全量可以问 `sub_list`）。 */
const DIGEST_LIMIT = 3

/** 一天的毫秒数（"几天后扣费"的换算基准；用 UTC+8 的日历日，不是本地时区）。 */
const DAY_MS = 86_400_000

/** UTC+8 偏移（与 `wallClockAt` 同源口径；提醒的"今天"必须与静默时段一致）。 */
const CST_OFFSET_MS = 8 * 3_600_000

/** 时区口径下的日历字段。 */
function wallOf(at: number): {
  readonly year: number
  readonly month: number
  readonly day: number
} {
  const shifted = new Date(at + CST_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/** `YYYY-MM`（订阅提醒的幂等键粒度：一个订阅一个扣款月一条；入参是 `dueAt`）。 */
function monthKeyOf(at: number): string {
  const wall = wallOf(at)
  return `${String(wall.year)}-${String(wall.month).padStart(2, '0')}`
}

/** `YYYY-MM-DD`（汇总的幂等键粒度：一天一条）。 */
function dayKeyOf(at: number): string {
  const wall = wallOf(at)
  return `${String(wall.year)}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`
}

/** `MM-DD`（正文里的到期日；不带年份，提醒只看最近的这一笔）。 */
function dueTextOf(dueAt: number): string {
  const wall = wallOf(dueAt)
  return `${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`
}

/** 距到期还有几天（向上取整：还差 2.5 天要说"3 天后"，不能说"2 天后"）。 */
function daysUntil(dueAt: number, at: number): number {
  return Math.max(0, Math.ceil((dueAt - at) / DAY_MS))
}

/**
 * 候选生成（**纯函数**：给定清单与时刻，输出该发哪几条）。
 *
 * 规则（逐条落地，任何一条都不许在别处再写一遍）：
 *
 * | 情形 | 行为 |
 * |---|---|
 * | 标了 `remind` 且进入 `aheadDays` 窗口 | 逐条提醒（`sub:<id>:<dueAt 的 YYYY-MM>`，`decision` 档） |
 * | 没标 remind 但 7 天内扣款 | 每天最多 1 条汇总（`sub:digest:<YYYY-MM-DD>`，`exec` 档），列前 3 条 |
 * | 标了 `idle`（我不用了） | 不提醒（两条路径都排除） |
 * | 已取消 / 已暂停 / 已断供 | 不提醒（`upcomingCharges` 只回 `active`，这里再兜一次） |
 */
export function reminderCandidatesOf(
  charges: readonly UpcomingCharge[],
  idleIds: ReadonlySet<string>,
  at: number,
): readonly ProactiveCandidate[] {
  const explicit: ProactiveCandidate[] = []
  const digestable: UpcomingCharge[] = []
  for (const charge of charges) {
    if (charge.subscriptionId === undefined || idleIds.has(charge.subscriptionId)) continue
    if (charge.dueAt < at) continue
    const days = daysUntil(charge.dueAt, at)
    const ahead = charge.reminderAheadDays
    if (ahead !== undefined) {
      // 标了 remind 的订阅**只走**逐条路径：还没进窗口时也不进汇总——
      // 用户已经指定了"提前几天说"，再塞进"7 天汇总"等于把同一笔说两遍。
      if (days > ahead) continue
      explicit.push({
        source: 'subscription',
        // 幂等键取**扣款日**所在月，不是判定时刻：跨月 tick 同一笔扣款时
        // 用 `at` 会换 key，用户会在扣款前一天/当天各收一次（复审 P1-4）。
        key: `sub:${charge.subscriptionId}:${monthKeyOf(charge.dueAt)}`,
        // 用户自己要求过的提醒 → `decision` 档（静默时段不推；没有同档最小间隔，
        // 几张订阅同日到期时逐条都能出去，不会被"攒到下一条"吃掉）
        priority: 'decision',
        at,
        title: `${charge.merchant} ${String(days)} 天后扣费 ${formatYuan(charge.amountCents)}`,
      })
      continue
    }
    if (days <= DIGEST_WINDOW_DAYS) digestable.push(charge)
  }

  if (digestable.length === 0) return explicit

  const listed = digestable.slice(0, DIGEST_LIMIT).map(
    (charge) =>
      `${charge.merchant} ${formatYuan(charge.amountCents)}（${dueTextOf(charge.dueAt)}）`,
  )
  const more = digestable.length > listed.length ? ` 等 ${String(digestable.length)} 笔` : ''
  return [
    ...explicit,
    {
      source: 'subscription',
      key: `sub:digest:${dayKeyOf(at)}`,
      // 汇总是"顺手一提"（最低档 `exec`：静默时段不推、日上限拦、同档间隔约束）
      priority: 'exec',
      at,
      title: `未来 ${String(DIGEST_WINDOW_DAYS)} 天有 ${String(digestable.length)} 笔自动续费：${listed.join('、')}${more}`,
    },
  ]
}

/** 服务的依赖（纯注入：单测可以直接喂账本与预算，不需要真插件）。 */
export interface ProactiveServiceDeps {
  /** 事件发射面；缺席（没有 `bank:tools` 的 profile）时投递一律判 `not-ready`。 */
  readonly audit: () => BankAudit | undefined
  /** 注入钟。 */
  readonly now: () => number
}

/**
 * 造服务：预算 + 幂等账本 + 落账。
 *
 * 两条账本都在内存、都不 durable：
 * - `sentAt`：key → 首次成功投递时刻。同 key 再来一律 `dedup`（**不落事件**——
 *   每个 tick 都补一条"没发"的审计等于用噪音填满日志）；
 * - `suppressedLogged`：`<key>@<日期>` → 已记录过一次"被压掉"。静默时段的提醒**不写**
 *   `sentAt`（下个 tick 还要重试），但审计不该每个 tick 记一遍。
 */
export function createProactiveService(deps: ProactiveServiceDeps): ProactiveService {
  const history: NotifyHistoryItem[] = []
  const sentAt = new Map<string, number>()
  const suppressedLogged = new Set<string>()

  return {
    async push(candidate) {
      const audit = deps.audit()
      if (audit === undefined) return { sent: false, channel: 'none', reason: 'not-ready' }
      if (sentAt.has(candidate.key)) return { sent: false, channel: 'none', reason: 'dedup' }

      const decision = deriveNotify(
        history,
        { priority: candidate.priority, at: candidate.at, key: candidate.key },
        DEFAULT_NOTIFY_BUDGET,
      )
      if (decision.send) {
        sentAt.set(candidate.key, candidate.at)
        history.push({ priority: candidate.priority, at: candidate.at, key: candidate.key })
        audit.append('proactive/reminder', {
          source: candidate.source,
          key: candidate.key,
          title: candidate.title,
          channel: 'in-app',
          at: candidate.at,
        })
        return { sent: true, channel: 'in-app', reason: 'ok' }
      }

      // `dedup` 是预算层的 5 分钟窗口：说明同 key 刚发过，不该再落一条"没发"的事件
      if (decision.reason !== 'dedup') {
        const stamp = `${candidate.key}@${dayKeyOf(candidate.at)}`
        if (!suppressedLogged.has(stamp)) {
          suppressedLogged.add(stamp)
          audit.append('proactive/reminder', {
            source: candidate.source,
            key: candidate.key,
            title: candidate.title,
            channel: 'none',
            suppressedReason: decision.reason,
            at: candidate.at,
          })
        }
      }
      return { sent: false, channel: 'none', reason: decision.reason }
    },
  }
}

/** 一次扫描的依赖。 */
export interface ProactiveScanDeps {
  readonly now: () => number
  /** 当前会话绑定的银行用户；未绑定返回 `undefined`（无身份即不提醒）。 */
  readonly userId: () => string | undefined
  readonly probe: SubscriptionProbe
  readonly push: ProactiveService['push']
}

/**
 * 扫一次并逐条投递。
 *
 * 只做三件事：取数（`bank:subscription-probe`，权威口径在 core）→ 生成候选（纯函数）
 * → 逐条 `push`。任何一条失败都不影响其余条目（提醒是尽力而为，不是事务）。
 */
export async function scanOnce(
  deps: ProactiveScanDeps,
): Promise<readonly ProactiveDelivery[]> {
  const userId = deps.userId()
  if (userId === undefined) return []
  const at = deps.now()
  const [charges, idleIds] = await Promise.all([
    deps.probe.upcoming(userId, DIGEST_WINDOW_DAYS),
    deps.probe.idleIds(userId),
  ])
  const candidates = reminderCandidatesOf(charges, new Set(idleIds), at)
  const delivered: ProactiveDelivery[] = []
  for (const candidate of candidates) {
    try {
      delivered.push(await deps.push(candidate))
    } catch (error) {
      logJson('warn', 'host.proactive-push-failed', {
        key: candidate.key,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return delivered
}

/** 懒取可选服务（没有 `bank:tools` 的 profile 不该因此启动失败）。 */
function optional<T>(get: () => T): T | undefined {
  try {
    return get()
  } catch {
    return undefined
  }
}

export const proactivePlugin: HostPlugin<ProactiveSettings> = {
  id: 'proactive:reminder',

  plugin: {
    name: 'proactive:reminder',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id],
    apply(ctx, settings) {
      if (!settings.enabled) return

      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)
      const sessionId = String(session.sessionId)

      const service = createProactiveService({
        audit: () => optional(() => ctx.get(BANK_AUDIT)),
        now: run.now,
      })
      ctx.effect(ctx.provide(PROACTIVE_SERVICE, service))

      const deps = (): ProactiveScanDeps | undefined => {
        const probe = optional(() => ctx.get(BANK_SUBSCRIPTION_PROBE))
        const identity = optional(() => ctx.get(BANK_IDENTITY))
        if (probe === undefined || identity === undefined) return undefined
        return {
          now: run.now,
          userId: () => identity.resolve(sessionId as SessionId),
          probe,
          push: service.push,
        }
      }

      /**
       * tick job：与 janitor / recon / anchor / plan-wake 共用 `saga/tick` 这**一个**时钟源。
       *
       * 不自建 interval 的理由同 `plan:scheduler`：第二个定时器 = 两份 due 判定，
       * 演示当天一定对不上。
       */
      ctx.effect(
        registerTickJob('sub-reminder', () => {
          const ready = deps()
          if (ready === undefined) return
          void scanOnce(ready).catch((error: unknown) => {
            logJson('error', 'host.proactive-scan-failed', {
              reason: error instanceof Error ? error.message : String(error),
            })
          })
        }),
      )

      /**
       * 生日扫描的依赖：只需要事实账本（`bah:fact`），不需要银行身份——
       * 事实本来就属于当前会话，重启后由 `replayFacts` 重建。
       */
      const birthdayDeps = (): BirthdayScanDeps | undefined => {
        const store = optional(() => ctx.get(FACT_SERVICE))
        if (store === undefined) return undefined
        return {
          now: run.now,
          facts: () => store.list({ kind: 'birthday' }),
          push: service.push,
        }
      }

      /**
       * 第二个 tick job：**不新开插件**（两个插件各建一条投递路径就是分叉）。
       * 与 `sub-reminder` 共用同一个 `saga/tick` 时钟源；job 名独立便于单测与心跳。
       */
      ctx.effect(
        registerTickJob('birthday-reminder', () => {
          const ready = birthdayDeps()
          if (ready === undefined) return
          void scanBirthdays(ready).catch((error: unknown) => {
            logJson('error', 'host.birthday-scan-failed', {
              reason: error instanceof Error ? error.message : String(error),
            })
          })
        }),
      )

      /**
       * boot 补跑：等 `bank:tools` 的服务就绪再跑（本行的装配顺序由 profile 决定，
       * 可能排在 `bank:tools` 之前；一次性微任务会把补跑静默吞掉）。
       *
       * **与 tick 用同一套规则**（含 7 天汇总），不是"只补明确提醒"：
       * `profiles/web` / `mobile` / `web-plan` 的 `bank:saga-bridge` 是 tick-only
       * （`eligible: []`，不接管工具），`saga/tick` 每 60s 派发一次；boot 补跑仍保留，
       * 否则"打开页面到第一个 tick 之间"会有最长 60s 的提醒空窗。
       *
       * 代价（已知）：进程每次启动都会按当天规则扫一遍；同一天重启会重发一次
       * （幂等账本在内存，不 durable —— 见文件头"重复一次可接受"）。
       */
      const timer: { handle?: ReturnType<typeof setTimeout> } = {}
      ctx.effect(() => {
        if (timer.handle !== undefined) clearTimeout(timer.handle)
      })
      if (settings.catchUpOnBoot) {
        const catchUp = (attempt: number): void => {
          const ready = deps()
          if (ready === undefined) {
            if (attempt < 20) {
              timer.handle = setTimeout(() => catchUp(attempt + 1), 50)
              timer.handle.unref?.()
            } else {
              logJson('warn', 'host.proactive-catchup-unavailable', { attempts: attempt })
            }
            return
          }
          void scanOnce(ready).catch((error: unknown) => {
            logJson('error', 'host.proactive-catchup-failed', {
              reason: error instanceof Error ? error.message : String(error),
            })
          })
        }
        queueMicrotask(() => catchUp(0))
      }

      /**
       * 生日补跑：与订阅补跑分开等各自的服务。
       *
       * 不能塞进上面的 `catchUp`：那个函数等的是 `bank:tools`（probe + identity），
       * 而生日只等 `fact:store`。捆在一起会让"装了事实库但没装银行工具"的 profile
       * 永远不扫生日——而生日恰恰是纯生活事实，不需要银行身份。
       */
      const birthdayTimer: { handle?: ReturnType<typeof setTimeout> } = {}
      ctx.effect(() => {
        if (birthdayTimer.handle !== undefined) clearTimeout(birthdayTimer.handle)
      })
      if (settings.catchUpOnBoot) {
        const catchUpBirthday = (attempt: number): void => {
          const ready = birthdayDeps()
          if (ready === undefined) {
            if (attempt < 20) {
              birthdayTimer.handle = setTimeout(() => catchUpBirthday(attempt + 1), 50)
              birthdayTimer.handle.unref?.()
            } else {
              logJson('warn', 'host.birthday-catchup-unavailable', { attempts: attempt })
            }
            return
          }
          void scanBirthdays(ready).catch((error: unknown) => {
            logJson('error', 'host.birthday-catchup-failed', {
              reason: error instanceof Error ? error.message : String(error),
            })
          })
        }
        queueMicrotask(() => catchUpBirthday(0))
      }
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['enabled', 'catchUpOnBoot'], WHERE)
    return {
      enabled: readBoolean(config, 'enabled', WHERE, DEFAULT_PROACTIVE.enabled),
      catchUpOnBoot: readBoolean(config, 'catchUpOnBoot', WHERE, DEFAULT_PROACTIVE.catchUpOnBoot),
    }
  },
}
