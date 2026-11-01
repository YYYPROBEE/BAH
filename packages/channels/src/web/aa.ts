/**
 * 「收款进度」表（`aa_create` 卡片专用）：从 `aa/created` / `read/aa` / `aa/collected` 派生。
 *
 * **为什么不新造一个帧**：AA 的每一次代收本身就是一次工具调用（`aa_create` 的 `collect`
 * 分支，见 `packages/bank/src/tools/aa.ts`），`tool` 帧已经到位，前端 `renderTool` 通用渲染。
 * 缺的只有"结构化清单"——正文里那份 `- 张三：¥100.00（已收）` 是给人读的文本，
 * 进度要能逐行比对就得是一张表。所以照 `subscriptions.ts` 的做法，做成卡片的一个块。
 *
 * 三条纪律（与 `subscriptions.ts` 逐条同）：
 * 1. **确定性**：不读时钟、不重排；顺序以 `aa/created` 落账时的参与人顺序为准，
 *    回放两次必须逐字相同；
 * 2. **只认事件**：`aa/collected` 只带"第几位 + 本次入账"，进度靠回放累加，不推演；
 * 3. **不补默认值**：字段缺失或形态不对的条目直接跳过，绝不猜名字与金额。
 */

import { formatCents } from './format.ts'

/** 表格列（参与人 / 份额 / 状态）。 */
export const AA_HEADERS = ['参与人', '份额', '状态'] as const
/** 卡片上最多列几条（人多的组不至于把卡片撑爆）。 */
export const AA_MAX_ROWS = 10

/** 参与人状态（与 `@bah/bank` 的 `AaParticipantStatus` 同值域；渠道不引业务包）。 */
export type AaParticipantState = 'pending' | 'paid' | 'declined' | 'expired'

/** 状态 → 表格里的中文标签（与 `bank/src/tools/aa.ts` 同一套字）。 */
export const AA_STATE_LABEL: Readonly<Record<AaParticipantState, string>> = {
  pending: '待收',
  paid: '已收',
  declined: '已拒绝',
  expired: '已过期',
}

/** 一位参与人的当前进度。 */
export interface AaParticipantProgress {
  readonly name: string
  readonly shareCents: number
  readonly status: AaParticipantState
  /** 便捷布尔（既有消费方按它渲染"已收"）；与 `status === 'paid'` 恒等。 */
  readonly paid: boolean
}

/** 一个 AA 组的当前进度（`aa/created` 建表 + 逐条事件推进的结果）。 */
export interface AaProgress {
  readonly groupId: string
  readonly title: string
  readonly totalCents: number
  readonly collectedCents: number
  readonly pendingCents: number
  readonly participants: readonly AaParticipantProgress[]
}

/** 从参与人状态重算两份汇总（展示口径永远与状态机一致）。 */
function totalsOf(participants: readonly AaParticipantProgress[]): {
  readonly collectedCents: number
  readonly pendingCents: number
} {
  let collectedCents = 0
  let pendingCents = 0
  for (const participant of participants) {
    if (participant.status === 'paid') collectedCents += participant.shareCents
    if (participant.status === 'pending') pendingCents += participant.shareCents
  }
  return { collectedCents, pendingCents }
}

/** 卡片上的一个块（字段摘要 + 表格 + 依据一行），与 `UpcomingBlock` 同形。 */
export interface AaBlock {
  readonly summary: string
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly note: string
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

/**
 * `aa/created` 或 `read/aa` 的事件载荷 → 组快照。
 *
 * 两者同一形状（`{ result: AaGroupResult }`）：create 返回新建的组，status 分支返回读到的组。
 * 形态不对就返回 `undefined`——宁可卡片少一块，也不显示半张对不上账的表。
 */
export function aaFromResult(data: unknown): AaProgress | undefined {
  const record = asRecord(data)
  const result = asRecord(record?.['result'])
  if (result === undefined) return undefined

  const groupId = str(result, 'groupId')
  const totalCents = num(result, 'totalCents')
  if (groupId === undefined || totalCents === undefined) return undefined

  const raw = result['participants']
  if (!Array.isArray(raw)) return undefined
  const participants: AaParticipantProgress[] = []
  for (const item of raw) {
    const entry = asRecord(item)
    if (entry === undefined) continue
    const name = str(entry, 'name')
    const shareCents = num(entry, 'shareCents')
    if (name === undefined || shareCents === undefined) continue
    const rawStatus = entry['status']
    const status: AaParticipantState =
      rawStatus === 'paid' || rawStatus === 'declined' || rawStatus === 'expired'
        ? rawStatus
        : 'pending'
    participants.push({ name, shareCents, status, paid: status === 'paid' })
  }
  // 空组没有可展示的进度；标题缺省也不算错（组名是用户输入的，可能为空）
  if (participants.length === 0) return undefined

  // 汇总从参与人状态现算：旧算法"总额 − 已收"会把 declined/expired 算成待收。
  return {
    groupId,
    title: str(result, 'title') ?? '',
    totalCents,
    ...totalsOf(participants),
    participants,
  }
}

/**
 * 一条 `aa/collected` → 推进后的快照。
 *
 * 幂等：同一位参与人重复代收（或事件重放）不重复累加；组号对不上就原样返回
 * `undefined`，由调用方保留旧快照——**不允许**把别的组的入账记到这一组头上。
 */
export function applyCollected(progress: AaProgress | undefined, data: unknown): AaProgress | undefined {
  if (progress === undefined) return undefined
  const record = asRecord(data)
  if (record === undefined) return undefined
  if (str(record, 'groupId') !== progress.groupId) return undefined

  const index = num(record, 'participantIndex')
  if (index === undefined || !Number.isInteger(index)) return undefined
  // `aa/collected.participantIndex` 就是 `participants` 的下标（见 bank 侧 `collectAa` 的返回）
  const target = progress.participants[index]
  if (target === undefined) return undefined
  if (target.status !== 'pending') return undefined

  const participants = progress.participants.map((participant, position) =>
    position === index ? { ...participant, status: 'paid' as const, paid: true } : participant,
  )
  // 代收金额用事件里的"本次入账"（它才是这笔流水的金额），并防超收。
  // 待收按**增量**减，而不是"总额 − 已收"：有 declined/expired 时后者会虚高。
  const amount = num(record, 'collectedCents') ?? target.shareCents
  const collectedCents = Math.min(progress.totalCents, progress.collectedCents + amount)
  const pendingCents = Math.max(0, progress.pendingCents - amount)
  return { ...progress, participants, collectedCents, pendingCents }
}

/**
 * 一条 `aa/participant-updated`（ADR-0017）→ 推进后的快照。
 *
 * 幂等：目标不是 `pending`（重复事件/已经被代收）就原样返回 `undefined`，
 * 由调用方保留旧快照。组号对不上同样忽略——别的组的状态不能记到这一组。
 */
export function applyParticipantUpdated(
  progress: AaProgress | undefined,
  data: unknown,
): AaProgress | undefined {
  if (progress === undefined) return undefined
  const record = asRecord(data)
  if (record === undefined) return undefined
  if (str(record, 'groupId') !== progress.groupId) return undefined

  const index = num(record, 'participantIndex')
  if (index === undefined || !Number.isInteger(index)) return undefined
  const rawTo = record['to']
  const to: 'declined' | 'expired' | undefined =
    rawTo === 'declined' ? 'declined' : rawTo === 'expired' ? 'expired' : undefined
  if (to === undefined) return undefined
  const target = progress.participants[index]
  if (target === undefined || target.status !== 'pending') return undefined

  const participants = progress.participants.map((participant, position) =>
    position === index
      ? { ...participant, status: to, paid: false }
      : participant,
  )
  return { ...progress, participants, ...totalsOf(participants) }
}

/**
 * 快照 → 卡片块。
 *
 * 已收齐时摘要改成"已收齐"，否则报"已收 N/M · 待收多少"——两者不能都写，
 * 一张卡上出现"已收齐"与"待收 ¥0.00"会让人以为还有钱没到。
 */
export function aaBlockOf(progress: AaProgress): AaBlock {
  const total = progress.participants.length
  const paid = progress.participants.filter((participant) => participant.paid).length
  const pending = progress.participants.filter((participant) => participant.status === 'pending').length
  const closed = total - paid - pending
  const complete = paid >= total
  const ended = pending === 0 && !complete

  const summary = complete
    ? `已收齐 ${String(paid)}/${String(total)}`
    : ended
      ? `已结束：已收 ${String(paid)}/${String(total)} · 未收 ${String(closed)} 人`
      : `已收 ${String(paid)}/${String(total)} · 待收 ${formatCents(progress.pendingCents)}` +
        (closed > 0 ? ` · ${String(closed)} 人已拒绝/过期` : '')

  const shown = progress.participants.slice(0, AA_MAX_ROWS)
  const rows = shown.map((participant) => [
    participant.name,
    formatCents(participant.shareCents),
    AA_STATE_LABEL[participant.status],
  ])

  const more = total > shown.length ? `（下列前 ${String(shown.length)} 人）` : ''
  const note = `总额 ${formatCents(progress.totalCents)} · ${String(total)} 人${more}`

  return { summary, headers: [...AA_HEADERS], rows, note }
}
