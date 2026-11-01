/**
 * 「即将扣款」块（订阅卡片专用）：从 `read/subscriptions` 事件派生，**不读时钟**。
 *
 * 数据来源只有一处：`sub_list` 执行时落账的 `read/subscriptions` 事件（ADR-0007 冻结载荷）。
 * UiCard 不落账，所以卡片正文里拿不到结构化清单；事件是唯一可回放的来源。
 *
 * 三条纪律：
 * 1. **确定性**：窗口基准用事件自己的 `at`，不用 `Date.now()`——回放两次必须逐字相同；
 * 2. **镜像槽位口径**：7 天窗口 + `reminderAheadDays` 提前量 + 按到期升序（与
 *    `packages/bank/src/context/slots.ts` 的【即将扣款】同一条规则，两处不许分叉）；
 * 3. **不猜**：字段缺失或形态不对的条目直接跳过，绝不补默认值。
 */

import { formatCents } from './format.ts'

/** 取数窗口（天）：与 bank 槽位 `UPCOMING_WINDOW_DAYS` 同值。 */
export const UPCOMING_WINDOW_DAYS = 7
/** 卡片上最多列几条（其余只报数）。 */
export const UPCOMING_LIMIT = 5

const DAY_MS = 24 * 60 * 60 * 1000

/** `read/subscriptions` 事件里我们真正要用的字段（宽松读取，形态不对就丢）。 */
export interface SubscriptionSnapshot {
  /** 该次查询的时刻（窗口基准）。 */
  readonly at: number
  /** 推断生成时刻（卡片「生成于」用）。 */
  readonly detectedAt: number
  /** 取证边界（卡片「基于近 N 天 M 笔流水」用）。 */
  readonly basisFrom: number
  readonly basisTo: number
  readonly txnCount: number
  readonly items: readonly SnapshotItem[]
}

export interface SnapshotItem {
  readonly subscriptionId: string
  readonly merchant: string
  readonly amountCents: number
  readonly nextChargeAt: number
  readonly status: string
  readonly reminderAheadDays?: number
}

/** 卡片上的一个块（字段摘要 + 表格 + 依据一行）。 */
export interface UpcomingBlock {
  readonly summary: string
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly basisNote: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** epoch ms → `YYYY-MM-DD`（UTC；与 `format.ts` 的其余格式化同口径，跨时区逐字相同）。 */
export function dateText(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * `read/subscriptions` 的事件载荷 → 快照。
 *
 * @returns `undefined` = 载荷形态不符（不产块，不抛错——时间线坏了不能拖垮对话）
 */
export function snapshotOf(data: unknown, eventAt: number): SubscriptionSnapshot | undefined {
  const record = asRecord(data)
  if (record === undefined) return undefined
  const result = asRecord(record['result'])
  const confirmed = result === undefined ? undefined : result['confirmed']
  if (!Array.isArray(confirmed)) return undefined
  const basis = asRecord(record['basis'])
  const items: SnapshotItem[] = []
  for (const raw of confirmed) {
    const item = asRecord(raw)
    if (item === undefined) continue
    const subscriptionId = str(item, 'subscriptionId')
    const merchant = str(item, 'merchant')
    const amountCents = num(item, 'amountCents')
    const nextChargeAt = num(item, 'nextChargeAt')
    const status = str(item, 'status')
    if (
      subscriptionId === undefined ||
      merchant === undefined ||
      amountCents === undefined ||
      nextChargeAt === undefined ||
      status === undefined
    ) {
      continue
    }
    const ahead = num(item, 'reminderAheadDays')
    items.push({
      subscriptionId,
      merchant,
      amountCents,
      nextChargeAt,
      status,
      ...(ahead === undefined ? {} : { reminderAheadDays: ahead }),
    })
  }
  const detectedAt = num(record, 'detectedAt') ?? eventAt
  return {
    at: eventAt,
    detectedAt,
    basisFrom: basis === undefined ? eventAt : (num(basis, 'from') ?? eventAt),
    basisTo: basis === undefined ? eventAt : (num(basis, 'to') ?? eventAt),
    txnCount: basis === undefined ? 0 : (num(basis, 'txnCount') ?? 0),
    items,
  }
}

/**
 * 快照 → 卡片块。
 *
 * 过滤与排序与 bank 槽位逐条一致：只看 `active`、窗口内、按 `reminderAheadDays` 收紧，
 * 到期升序、同刻按 `subscriptionId` 升序。窗口内一条都没有也出块（如实说"没有"）。
 */
export function upcomingBlockOf(snapshot: SubscriptionSnapshot): UpcomingBlock {
  const now = snapshot.at
  const horizon = now + UPCOMING_WINDOW_DAYS * DAY_MS
  const selected = snapshot.items
    .filter((item) => {
      if (item.status !== 'active') return false
      if (item.nextChargeAt < now || item.nextChargeAt > horizon) return false
      const days = (item.nextChargeAt - now) / DAY_MS
      return days <= (item.reminderAheadDays ?? UPCOMING_WINDOW_DAYS)
    })
    .sort(
      (left, right) =>
        left.nextChargeAt - right.nextChargeAt ||
        (left.subscriptionId < right.subscriptionId ? -1 : left.subscriptionId > right.subscriptionId ? 1 : 0),
    )

  const totalCents = selected.reduce((sum, item) => sum + item.amountCents, 0)
  const summary =
    selected.length === 0
      ? `${String(UPCOMING_WINDOW_DAYS)} 天内没有即将扣款`
      : `${String(selected.length)} 项 · ${String(UPCOMING_WINDOW_DAYS)} 天内共 ${formatCents(totalCents)}`

  const shown = selected.slice(0, UPCOMING_LIMIT)
  const rows = shown.map((item) => [
    item.merchant,
    formatCents(item.amountCents),
    dueText(item.nextChargeAt, now),
  ])
  const days = Math.max(0, Math.round((snapshot.basisTo - snapshot.basisFrom) / DAY_MS))
  const basisNote = `基于近 ${String(days)} 天 ${String(snapshot.txnCount)} 笔流水 · 生成于 ${dateText(snapshot.detectedAt)}`

  return {
    summary: selected.length > shown.length ? `${summary}（下列前 ${String(shown.length)} 项）` : summary,
    headers: ['即将扣款', '金额', '扣款日'],
    rows,
    basisNote,
  }
}

/** 到期日文案：`MM-DD（N 天后）`；同刻写「今天」。 */
function dueText(dueAt: number, now: number): string {
  const date = dateText(dueAt).slice(5)
  const days = Math.ceil((dueAt - now) / DAY_MS)
  return days <= 0 ? `${date}（今天）` : `${date}（${String(days)} 天后）`
}
