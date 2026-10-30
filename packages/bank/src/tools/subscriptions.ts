/**
 * 场景 5 的三个新工具（P4）：
 *
 * - `sub_list`（绿）：订阅清单 + 周期检测 + 三分法 + 断供核验（只读；推断不落账）；
 * - `sub_watch`（黄）：提醒 / 标注（写事实账本的两个字段）；
 * - `sub_authorize`（黄）：关闭商户代扣协议（**只关不开**）。
 *
 * 工具层只做三件事：校验参数 → 调 core → 落领域事件。
 * 检测与核验都是 `detect/` 的纯函数，工具不自己推导、也不回写实体。
 */

import type { ToolDefinition } from '@bah/core'
import { BahError } from '@bah/util'

import type {
  ChargeCycle,
  MerchantAuthorization,
  Subscription,
  SubscriptionId,
  UserId,
} from '../core/index.ts'
import { DAY_MS, formatYuan } from '../core/index.ts'
import {
  DETECTOR_VERSION,
  detectRecurring,
  deriveCutoffFindings,
  normalizeMerchant,
} from '../detect/index.ts'
import { requireUserId } from './accounts.ts'
import { argsError, readOptionalPositiveInteger, readRequiredEnum, readString } from './args.ts'
import type {
  CutoffFindingView,
  SpendSplitView,
  SubscriptionItemView,
  SubscriptionListResult,
  SubscriptionSeriesView,
} from './dto.ts'
import { subscriptionsCard, subscriptionAuthorizeConfirmCard } from './presenters.ts'
import { specOf } from './specs.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** `sub_watch` 的写入口（三态）。 */
export type WatchMode = 'remind' | 'idle' | 'none'
const WATCH_MODES: readonly WatchMode[] = ['remind', 'idle', 'none']
const CANCEL_MODES = ['now', 'at-next-cycle'] as const

/** `sub_list` 的取证窗口（与检测默认值同源；这里只用于取数分页）。 */
const DETECT_WINDOW_DAYS = 180
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30

/** `sub_watch` 的结果。 */
export interface SubscriptionWatchResult {
  readonly subscriptionId: string
  readonly merchant: string
  readonly watch: WatchMode
  readonly aheadDays?: number
  readonly note?: 'idle' | 'hesitating'
  readonly reminderAheadDays?: number
  readonly at: number
}

/** `sub_authorize` 的结果。 */
export interface SubscriptionAuthorizationRevokedResult {
  readonly authorizationId: string
  readonly merchant: string
  readonly status: 'revoked'
  readonly affected: number
  readonly affectedSubscriptions: readonly string[]
  readonly restoreHint: string
  readonly verifyBy: number
  readonly revokedAt: number
}

/** `sub_list`：绿档只读（推断不落账）。 */
export function createSubListTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, SubscriptionListResult> {
  const spec = specOf('sub_list')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const now = clockOf(deps)()
      const limit = readLimit(args)
      const detailId = typeof args['subscriptionId'] === 'string' ? args['subscriptionId'].trim() : undefined

      const [subscriptions, authorizations, cancelRequests] = await Promise.all([
        deps.core.listSubscriptions(userId),
        deps.core.listAuthorizations(userId),
        deps.core.listCancelRequests(userId),
      ])
      const transactions = await loadOutgoing(deps, userId, now)
      const detection = detectRecurring(transactions, { now, subscriptions })
      const cutoff = deriveCutoffFindings({
        transactions,
        cancelRequests,
        authorizations,
        subscriptions,
        now,
      })

      const result = buildListResult({
        subscriptions,
        authorizations,
        detection,
        cutoff,
        now,
        limit,
        ...(detailId === undefined ? {} : { detailId }),
      })
      deps.audit.append('read/subscriptions', {
        result,
        detectedAt: now,
        basis: detection.basis,
        detectorVersion: DETECTOR_VERSION,
      })
      return result
    },
    projectContent: (result) => {
      const split = result.spendSplit
      const lines = [
        `订阅 ${String(split.subscriptionCount)} 项，月固定 ${formatYuan(split.subscriptionCents)}；` +
          `账单 ${String(split.billCount)} 项；分期 ${String(split.installmentCount)} 项。`,
      ]
      const upcoming = result.detected[0]
      if (upcoming !== undefined) {
        const days = Math.max(0, Math.round((upcoming.nextChargeAt - result.detectedAt) / DAY_MS))
        const hike =
          upcoming.priceHike === undefined
            ? ''
            : `（较上期涨 ${formatYuan(upcoming.priceHike.toCents - upcoming.priceHike.fromCents)}）`
        lines.push(
          `最近一笔：${sanitizeMerchantForPrompt(upcoming.displayName)} ${String(days)} 天后 ${formatYuan(upcoming.amountCents)}${hike}`,
        )
      }
      const finding = result.cutoffFindings.find(
        (item) => item.verdict === 'failed' || item.verdict === 'breached',
      )
      if (finding !== undefined) {
        lines.push(`注意：${finding.hint}（${sanitizeMerchantForPrompt(finding.merchantKey)}）`)
      }
      return [{ type: 'text', text: lines.slice(0, 3).join('\n') }]
    },
    presentResult: (_args, result) => subscriptionsCard(result),
  }
}

/** `sub_watch`：黄档写（提醒 / 标注）。 */
export function createSubWatchTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, SubscriptionWatchResult> {
  const spec = specOf('sub_watch')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const subscriptionId = readString(args, 'subscriptionId', spec.name) as SubscriptionId
      const watch = readRequiredEnum(args, 'watch', spec.name, WATCH_MODES)
      const aheadDays = readOptionalPositiveInteger(args, 'aheadDays', spec.name)
      if (watch !== 'remind' && aheadDays !== undefined) {
        throw argsError('sub_watch.aheadDays 只对 watch=remind 有效', { watch, aheadDays })
      }
      const updated = await deps.core.setSubscriptionWatch(
        userId,
        subscriptionId,
        watch === 'remind'
          ? { watch, ...(aheadDays === undefined ? {} : { aheadDays }) }
          : { watch },
      )
      const at = clockOf(deps)()
      deps.audit.append('sub/watch-updated', {
        subscriptionId: updated.id,
        watch,
        ...(watch === 'remind' ? { aheadDays: updated.reminderAheadDays ?? 3 } : {}),
        at,
      })
      return {
        subscriptionId: updated.id,
        merchant: updated.merchant,
        watch,
        ...(updated.reminderAheadDays === undefined ? {} : { aheadDays: updated.reminderAheadDays }),
        ...(updated.note === undefined ? {} : { note: updated.note }),
        ...(updated.reminderAheadDays === undefined
          ? {}
          : { reminderAheadDays: updated.reminderAheadDays }),
        at,
      }
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          result.watch === 'remind'
            ? `已设置「${sanitizeMerchantForPrompt(result.merchant)}」到期前 ${String(result.aheadDays ?? 3)} 天提醒。`
            : result.watch === 'idle'
              ? `已把「${sanitizeMerchantForPrompt(result.merchant)}」标注为“不用了”，下次会在清单里提示。`
              : `已清除「${sanitizeMerchantForPrompt(result.merchant)}」的提醒与标注。`,
      },
    ],
  }
}

/** `sub_authorize`：黄档写（关协议；只关不开）。 */
export function createSubAuthorizeTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, SubscriptionAuthorizationRevokedResult> {
  const spec = specOf('sub_authorize')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const merchantInput = readString(args, 'merchant', spec.name)
      const key = normalizeMerchant(merchantInput)
      const authorizations = await deps.core.listAuthorizations(userId)
      // 已关的协议也允许再次命中：core 的 revoke 是幂等的，重复说"彻底停掉"不该报未知
      const target = authorizations.find(
        (item) =>
          item.merchantKey === key || normalizeMerchant(item.merchant) === key,
      )
      if (target === undefined) {
        throw new BahError('authorization-unknown', `bank: 未找到「${merchantInput}」的代扣协议`, {
          merchant: merchantInput,
          merchantKey: key,
        })
      }
      const revoked = await deps.core.revokeAuthorization(userId, target.id)
      const at = clockOf(deps)()
      const subscriptions = await deps.core.listSubscriptions(userId)
      const affected = subscriptions.filter((item) =>
        revoked.affectedSubscriptions.some((id) => id === item.id),
      )
      const verifyBy =
        affected.length === 0
          ? at + 35 * DAY_MS
          : Math.min(...affected.map((item) => item.nextChargeAt)) + 3 * DAY_MS
      deps.audit.append('sub/authorization-revoked', {
        authorizationId: revoked.authorizationId,
        merchant: revoked.merchant,
        affected: revoked.affectedSubscriptions.length,
        at,
      })
      return {
        authorizationId: revoked.authorizationId,
        merchant: revoked.merchant,
        status: 'revoked',
        affected: revoked.affectedSubscriptions.length,
        affectedSubscriptions: revoked.affectedSubscriptions,
        restoreHint: '恢复扣款需在商户侧重新签约（小程序/柜台/客服），银行侧不代签',
        verifyBy,
        revokedAt: revoked.revokedAt,
      }
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `已关闭对「${sanitizeMerchantForPrompt(result.merchant)}」的代扣协议，影响 ${String(result.affected)} 个订阅。` +
          `${result.restoreHint}；核验窗口至 ${new Date(result.verifyBy).toISOString().slice(0, 10)}。`,
      },
    ],
    presentCall: (args) => subscriptionAuthorizeConfirmCard(args, deps.config.ticketTtlSeconds),
  }
}

/**
 * 商户名进提示词前的净化（复用实体槽位的同一套纪律）：
 * NFKC → 去控制符/零宽/双向控制 → 折叠空白 → 单行 → 截 32 码点。
 *
 * 数据里的商户名是不可信输入；它在卡片上可以原样展示，但**进模型上下文前必须限形**。
 */
export function sanitizeMerchantForPrompt(raw: string): string {
  const text = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...text].slice(0, 32).join('')
}

/* ── 内部组装 ─────────────────────────────────────────────────────────────── */

function readLimit(args: Readonly<Record<string, unknown>>): number {
  const limit = readOptionalPositiveInteger(args, 'limit', 'sub_list')
  if (limit === undefined) return DEFAULT_LIMIT
  if (limit < 1 || limit > MAX_LIMIT) {
    throw argsError(`sub_list.limit 必须在 1..${MAX_LIMIT}（收到 ${String(limit)}）`, { limit })
  }
  return limit
}

/** 取近 180 天全部转出流水（分页直到没有下一页）。 */
async function loadOutgoing(
  deps: BankToolDeps,
  userId: UserId,
  now: number,
): Promise<readonly import('../core/index.ts').Transaction[]> {
  const items: import('../core/index.ts').Transaction[] = []
  let cursor: string | undefined
  for (let page = 0; page < 100; page += 1) {
    const result = await deps.core.queryTransactions({
      userId,
      from: now - DETECT_WINDOW_DAYS * DAY_MS,
      to: now,
      direction: 'out',
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    })
    items.push(...result.items)
    if (result.nextCursor === undefined) break
    cursor = result.nextCursor
  }
  return items
}

interface BuildListInput {
  readonly subscriptions: readonly Subscription[]
  readonly authorizations: readonly MerchantAuthorization[]
  readonly detection: ReturnType<typeof detectRecurring>
  readonly cutoff: readonly ReturnType<typeof deriveCutoffFindings>[number][]
  readonly now: number
  readonly limit: number
  readonly detailId?: string
}

function buildListResult(input: BuildListInput): SubscriptionListResult {
  const authStatus = new Map(input.authorizations.map((item) => [String(item.id), item.status]))
  const visible =
    input.detailId === undefined
      ? input.subscriptions.filter((item) => item.status !== 'cancelled')
      : input.subscriptions.filter((item) => String(item.id) === input.detailId)
  if (input.detailId !== undefined && visible.length === 0) {
    throw new BahError('subscription-unknown', `bank: 未知订阅：${input.detailId}`, {
      subscriptionId: input.detailId,
    })
  }

  const confirmed: SubscriptionItemView[] = visible
    .map((item) => toItemView(item, authStatus))
    .sort((left, right) => left.nextChargeAt - right.nextChargeAt)

  const idleKeys = new Set(confirmed.filter((item) => item.note === 'idle').map((item) => item.merchantKey))
  const riskyKeys = new Set(
    input.cutoff
      .filter((item) => item.verdict === 'failed' || item.verdict === 'breached')
      .map((item) => item.merchantKey),
  )

  const selectedIds = new Set(confirmed.map((item) => String(item.subscriptionId)))
  const selectedKeys = new Set(confirmed.map((item) => item.merchantKey))
  const subscriptionById = new Map(
    input.subscriptions.map((item) => [String(item.id), item] as const),
  )
  const detectedAll = input.detection.series
    .filter((item) => item.confidence !== 'low')
    .filter(
      (item) =>
        input.detailId === undefined ||
        selectedKeys.has(item.merchantKey) ||
        (item.matchedSubscriptionId !== undefined && selectedIds.has(String(item.matchedSubscriptionId))),
    )
    .map((item) => toSeriesView(item, subscriptionById))

  const priority = (item: SubscriptionSeriesView): number => {
    if (item.priceHike !== undefined) return 0
    if (riskyKeys.has(item.merchantKey)) return 1
    if (idleKeys.has(item.merchantKey)) return 2
    return 3
  }
  const detected = detectedAll
    .sort(
      (left, right) =>
        priority(left) - priority(right) ||
        right.monthlyCents - left.monthlyCents ||
        (left.merchantKey < right.merchantKey ? -1 : left.merchantKey > right.merchantKey ? 1 : 0),
    )
    .slice(0, input.detailId === undefined ? input.limit : MAX_LIMIT)

  const cutoffFindings: CutoffFindingView[] = input.cutoff
    .filter(
      (item) =>
        input.detailId === undefined ||
        selectedKeys.has(item.merchantKey) ||
        (item.subscriptionId !== undefined && selectedIds.has(String(item.subscriptionId))),
    )
    .map((item) => ({
      kind: item.kind,
      verdict: item.verdict,
      merchantKey: item.merchantKey,
      ...(item.subscriptionId === undefined ? {} : { subscriptionId: item.subscriptionId }),
      ...(item.authorizationId === undefined ? {} : { authorizationId: item.authorizationId }),
      ...(item.level === undefined ? {} : { level: item.level }),
      hint: item.hint,
      dueAt: item.dueAt,
    }))

  return {
    confirmed,
    detected,
    spendSplit: spendSplitOf(input.detection.series),
    cutoffFindings,
    detectedAt: input.now,
    basis: input.detection.basis,
    detectorVersion: DETECTOR_VERSION,
  }
}

function toItemView(
  subscription: Subscription,
  authStatus: ReadonlyMap<string, 'active' | 'revoked'>,
): SubscriptionItemView {
  const merchantKey = normalizeMerchant(subscription.merchantKey ?? subscription.merchant)
  const authorizationStatus =
    subscription.authorizationId === undefined
      ? undefined
      : authStatus.get(String(subscription.authorizationId))
  return {
    subscriptionId: subscription.id,
    merchant: subscription.merchant,
    merchantKey,
    cycle: subscription.cycle,
    amountCents: subscription.amountCents,
    monthlyCents: monthlyCents(subscription.amountCents, subscription.cycle),
    nextChargeAt: subscription.nextChargeAt,
    status: subscription.status,
    ...(subscription.note === undefined ? {} : { note: subscription.note }),
    ...(subscription.reminderAheadDays === undefined
      ? {}
      : { reminderAheadDays: subscription.reminderAheadDays }),
    ...(subscription.contractEndAt === undefined ? {} : { contractEndAt: subscription.contractEndAt }),
    ...(subscription.pauseUntil === undefined ? {} : { pauseUntil: subscription.pauseUntil }),
    ...(authorizationStatus === undefined ? {} : { authorizationStatus }),
  }
}

function toSeriesView(
  item: ReturnType<typeof detectRecurring>['series'][number],
  subscriptionById: ReadonlyMap<string, Subscription>,
): SubscriptionSeriesView {
  // 已对上事实库时，下次扣款以上位账本为准：推断值只用于「没有订阅事实」的检测结果
  const matched =
    item.matchedSubscriptionId === undefined
      ? undefined
      : subscriptionById.get(String(item.matchedSubscriptionId))
  return {
    merchantKey: item.merchantKey,
    displayName: item.displayName,
    kind: item.kind,
    cycle: item.cycle,
    amountCents: item.amountCents,
    monthlyCents: monthlyCents(item.amountCents, item.cycle),
    confidence: item.confidence,
    nextChargeAt: matched?.nextChargeAt ?? item.nextChargeAt,
    count: item.instances.length,
    ...(item.priceHike === undefined ? {} : { priceHike: item.priceHike }),
    ...(item.priceDrop === undefined ? {} : { priceDrop: item.priceDrop }),
    ...(item.trialConverted === undefined ? {} : { trialConverted: item.trialConverted }),
    ...(item.suspectedInstallment === undefined
      ? {}
      : { suspectedInstallment: item.suspectedInstallment }),
    ...(item.matchedSubscriptionId === undefined
      ? {}
      : { matchedSubscriptionId: item.matchedSubscriptionId }),
  }
}

/** 月折算：周 ×52/12；季 ÷3；月不变。 */
function monthlyCents(amountCents: number, cycle: ChargeCycle): number {
  if (cycle === 'weekly') return Math.round((amountCents * 52) / 12)
  if (cycle === 'quarterly') return Math.round(amountCents / 3)
  return amountCents
}

function spendSplitOf(series: readonly ReturnType<typeof detectRecurring>['series'][number][]): SpendSplitView {
  let subscriptionCents = 0
  let billCents = 0
  let installmentCents = 0
  let subscriptionCount = 0
  let billCount = 0
  let installmentCount = 0
  for (const item of series) {
    const cents = monthlyCents(item.amountCents, item.cycle)
    if (item.kind === 'bill') {
      billCents += cents
      billCount += 1
    } else if (item.kind === 'installment') {
      installmentCents += cents
      installmentCount += 1
    } else {
      subscriptionCents += cents
      subscriptionCount += 1
    }
  }
  return {
    subscriptionCents,
    billCents,
    installmentCents,
    subscriptionCount,
    billCount,
    installmentCount,
  }
}

/** `sub_cancel` 的取消档（与 `sub_authorize` 共用枚举校验）。 */
export { CANCEL_MODES }
