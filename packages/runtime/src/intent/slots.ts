/**
 * 槽位归一化与两层合并（03 单 §3.4）。
 *
 * 本文件是意图平面唯一的「单位与 PII 边界」：进来的都是原话片段，出去的必须是
 * integer 分与脱敏形态。错一位小数或漏一次脱敏都是事故，所以每个函数都 fail-loud。
 */

import { BahError } from '@bah/util'

import type { FilledSlot, IntentKind, SlotConflict, SlotName, SlotSource, SlotTable } from './types.ts'

/** 资金类槽位：决定 `requiresPreview` 与并行批次准入。 */
export const FUND_SLOT_NAMES: ReadonlySet<SlotName> = new Set(['payee', 'account', 'amountCents'])

/** 复姓表：证据与展示两层共用，避免「欧阳**」在一处变成「欧**」。 */
const COMPOUND_SURNAMES: ReadonlySet<string> = new Set([
  '欧阳',
  '司马',
  '上官',
  '诸葛',
  '东方',
  '皇甫',
  '尉迟',
  '公孙',
  '慕容',
  '长孙',
])

/**
 * 金额归一化：元 → 分（integer）。
 *
 * WHY 字符串入参：`'500.50'` 与 `500.5` 在 JSON 反序列化后不可区分，但入参校验阶段还是字符串，
 * 在字符串上做精度判定才能给出确定性的 fail-loud。
 */
export function yuanToCents(yuan: string): number {
  const trimmed = yuan.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    // 负数、多小数点、超两位小数、非数字一律拒绝：宁可追问，不做四舍五入的「聪明事」
    throw new BahError('intent-amount-invalid', `金额无法归一化为分: ${redactAmount(trimmed)}`)
  }
  const [int = '0', frac = ''] = trimmed.split('.')
  return Number(int) * 100 + Number(frac.padEnd(2, '0'))
}

export function centsToYuan(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new BahError('intent-amount-invalid', '分金额必须为非负整数')
  }
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`
}

/** 非法金额的报错文本：只回显长度与首字符，不复述原文（原话可能就是卡号）。 */
function redactAmount(raw: string): string {
  return raw.length === 0 ? '（空）' : `（${String(raw.length)} 字符，首字符 ${raw.slice(0, 1)}）`
}

/** 手机号脱敏：138****5678。WHY 保留前 3 后 4：前 3 是号段（可解释性），后 4 是用户自查习惯。 */
export function maskPhone(phone: string): string {
  if (!/^1\d{10}$/.test(phone)) throw new BahError('intent-pii-invalid', '非标准手机号，拒绝入证据')
  return `${phone.slice(0, 3)}****${phone.slice(7)}`
}

/** 姓名脱敏：保留姓氏，名以 ** 代替（复姓按双字姓处理）。 */
export function maskName(name: string): string {
  if (name.length === 0) throw new BahError('intent-pii-invalid', '空姓名')
  const surname = COMPOUND_SURNAMES.has(name.slice(0, 2)) ? name.slice(0, 2) : name.slice(0, 1)
  return `${surname}**`
}

/** 账户只允许尾号形态出模块：****1234。全账号在任何出参/证据/日志中都是违规。 */
export function accountTail(account: string): string {
  if (!/^\d{8,}$/.test(account)) throw new BahError('intent-pii-invalid', '账号形态非法，拒绝截尾')
  return `****${account.slice(-4)}`
}

/* ────────────────────────────── 原话抽取 ────────────────────────────── */

const AMOUNT_WITH_UNIT = /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:元|块|rmb|RMB)/
const AMOUNT_PLAIN = /(\d[\d,]*(?:\.\d{1,2})?)/
const PAYEE_PATTERNS: readonly RegExp[] = [
  /给\s*([^\s，。！？,、]{1,8}?)\s*(?:转|汇款|打款|打钱)/,
  /转给\s*([^\s，。！？,、]{1,8})/,
  /收款人[:：]?\s*([^\s，。！？,、]{1,8})/,
]
/** 时间线索 → 天数（相对今天）。演示只用「今天/最近/上个月」三档，别的一律不猜。 */
const RELATIVE_DAYS: readonly (readonly [RegExp, number])[] = [
  [/今天|今日/, 0],
  [/昨天|昨日/, 1],
  [/最近|这几天|本周/, 7],
  [/上个月|上月/, 30],
]
const ACCOUNT_TAIL = /尾号\s*(\d{4})/

/** 原话里一个可能被归一化的槽位事实。 */
export interface UtteranceSlots {
  readonly slots: readonly FilledSlot[]
  /** 命中的原话片段（供 evidence 使用；已脱敏）。 */
  readonly amountSpan?: string
  readonly payeeSpan?: string
}

/**
 * 从原话抽槽位。
 *
 * 只做「确定性词法」：金额（元→分）、收款人（给X转）、账户尾号、相对时间。
 * 不做任何猜测——抽不出来就留空，由 resolve 的 missing 判据去追问。
 */
export function normalizeUtteranceSlots(utterance: string, today: string, scene: string): UtteranceSlots {
  const slots: FilledSlot[] = []
  let amountSpan: string | undefined
  let payeeSpan: string | undefined

  const amount = extractAmountCents(utterance)
  if (amount !== undefined) {
    slots.push({ name: 'amountCents', value: amount.cents, source: 'utterance', confidence: 0.95 })
    amountSpan = amount.span
  }

  const payee = extractPayee(utterance)
  if (payee !== undefined) {
    slots.push({ name: 'payee', value: payee, source: 'utterance', confidence: 0.9 })
    payeeSpan = payee
  }

  const tail = ACCOUNT_TAIL.exec(utterance)?.[1]
  if (tail !== undefined) {
    slots.push({ name: 'account', value: `****${tail}`, source: 'utterance', confidence: 0.9 })
  }

  const timeRange = extractTimeRange(utterance, today)
  if (timeRange !== undefined) {
    slots.push({ name: 'timeRange', value: timeRange, source: 'utterance', confidence: 0.85 })
  }

  // scene 只用于「同一句在原话里没有金额时是否要留空」，不参与抽取；
  // 保留参数是为了让调用方语义显式（抽取与场景相关是未来扩展点，现在恒等）。
  void scene

  return {
    slots,
    ...(amountSpan === undefined ? {} : { amountSpan }),
    ...(payeeSpan === undefined ? {} : { payeeSpan }),
  }
}

/** 金额抽取：优先带「元/块」后缀的数字，避免把尾号或验证码当金额。 */
export function extractAmountCents(text: string): { cents: number; span: string } | undefined {
  const withUnit = AMOUNT_WITH_UNIT.exec(text)
  if (withUnit?.[1] !== undefined) {
    const cents = yuanToCents(withUnit[1].replace(/,/g, ''))
    return { cents, span: withUnit[0] }
  }
  const plain = AMOUNT_PLAIN.exec(text)
  if (plain?.[1] === undefined) return undefined
  // 明显是卡号/尾号的（≥8 位）不当金额：与 memory-store 的实体抽取同口径
  if (plain[1].replace(/[,.]/g, '').length >= 8) return undefined
  return { cents: yuanToCents(plain[1].replace(/,/g, '')), span: plain[0] }
}

/** 收款人抽取：`给X转` / `转给X` / `收款人:X`。代词不入槽位（那是 R-VAGUE-3 的事）。 */
export function extractPayee(text: string): string | undefined {
  for (const pattern of PAYEE_PATTERNS) {
    const name = pattern.exec(text)?.[1]?.trim()
    if (name !== undefined && name.length > 0 && !/^\d+$/.test(name) && !PRONOUN_SET.has(name)) {
      return name
    }
  }
  return undefined
}

const PRONOUN_SET: ReadonlySet<string> = new Set(['他', '她', '它', '他们', '她们', '它们'])

/** 时间段归一化：'YYYY-MM-DD..YYYY-MM-DD'。基准来自注入的 today，不读时钟。 */
export function extractTimeRange(text: string, today: string): string | undefined {
  for (const [pattern, days] of RELATIVE_DAYS) {
    if (!pattern.test(text)) continue
    const from = addDays(today, -days)
    return `${from}..${today}`
  }
  return undefined
}

/** ISO 日期加减（只处理 YYYY-MM-DD，用 UTC 避免本地时区把日期拨过界）。 */
export function addDays(isoDate: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (match === null) throw new BahError('intent-date-invalid', 'today 必须是 YYYY-MM-DD')
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  // 带参 new Date(ms) 是合法形态：这里没有读系统时钟，只是在注入日期上做日历运算
  const shifted = new Date(base + deltaDays * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

/* ────────────────────────────── 合并与冲突 ────────────────────────────── */

/** 来源优先级（数值越大越优先）：user-choice > utterance > tool > session > memory。 */
export const SOURCE_PRIORITY: Readonly<Record<SlotSource, number>> = {
  'user-choice': 5,
  utterance: 4,
  tool: 3,
  session: 2,
  memory: 1,
}

/** 记忆快照的最小形状（recall.ts 的 `RecallSnapshot` 结构兼容；此处只声明用到的字段）。 */
export interface MergeMemory {
  readonly sceneTag: SlotName | string
  readonly confidence: number
  readonly fields: readonly { readonly name: SlotName; readonly value: string | number }[]
}

/**
 * 两层合并：按来源优先级**覆盖**，同优先级内多值保留为候选。
 *
 * WHY 覆盖而不是「把所有候选摊平」：「改成800」的会话层旧值 500.00 与本轮 800.00
 * 不是冲突，是本轮改写；把它们都留下会让每次改口都变成歧义追问。
 * 真正的歧义（记忆里两个「张伟」）由 `detectConflicts`（同优先级多值）与
 * resolve 的实体消歧（一个名字对多条记忆）分别捕获。
 */
export function mergeByPriority(
  table: SlotTable,
  utterance: readonly FilledSlot[],
  memory: readonly FilledSlot[] = [],
): readonly FilledSlot[] {
  const pools = new Map<SlotName, Map<number, FilledSlot[]>>()
  const add = (slot: FilledSlot): void => {
    const byPriority = pools.get(slot.name) ?? new Map<number, FilledSlot[]>()
    const priority = SOURCE_PRIORITY[slot.source]
    const list = byPriority.get(priority) ?? []
    list.push(slot)
    byPriority.set(priority, list)
    pools.set(slot.name, byPriority)
  }
  const addAll = (slots: readonly (FilledSlot | undefined)[]): void => {
    for (const slot of slots) if (slot !== undefined) add(slot)
  }
  addAll(Object.values(table.session))
  addAll(memory)
  addAll(Object.values(table.turn))
  addAll(utterance)

  const merged: FilledSlot[] = []
  for (const byPriority of pools.values()) {
    const top = Math.max(...byPriority.keys())
    const seen = new Set<string | number>()
    for (const slot of byPriority.get(top) ?? []) {
      if (seen.has(slot.value)) continue
      seen.add(slot.value)
      merged.push(slot)
    }
  }
  return merged
}

/** 冲突检测：同名槽位出现 ≥2 个不同 value（不同来源或同来源多候选）。 */
export function detectConflicts(filled: readonly FilledSlot[]): readonly SlotConflict[] {
  const byName = new Map<SlotName, FilledSlot[]>()
  for (const slot of filled) {
    const list = byName.get(slot.name) ?? []
    list.push(slot)
    byName.set(slot.name, list)
  }
  const conflicts: SlotConflict[] = []
  for (const [name, list] of byName) {
    const distinct = new Set(list.map((item) => item.value))
    if (distinct.size > 1) conflicts.push({ name, candidates: list })
  }
  // 确定性排序：按槽位名码点，避免 Map 插入序随来源顺序漂移
  return conflicts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 每个场景的必填槽位（静态表；不进插件，避免「规则在装配层」）。 */
export const REQUIRED_SLOTS: Readonly<Record<string, readonly SlotName[]>> = {
  transfer: ['payee', 'amountCents'],
  bills: ['timeRange'],
  investment: ['product'],
  // 卡场景的必填槽位不是账户：用户说的是卡，不是账户（卡槽位属 P2）
  card: [],
  subscription: [],
  cross_scene: ['targetScene'],
  unknown: [],
}

/**
 * 缺失判定：按 (kind, scene) 查 `REQUIRED_SLOTS`。
 *
 * 只有 explicit / vague / elliptical 判缺失：implicit 恒 propose、ambiguous 恒 ask，
 * 缺什么由 askHint 的 conflicts 表达。
 */
export function findMissing(
  kind: IntentKind,
  scene: string,
  filled: readonly FilledSlot[],
  conflicts: readonly SlotConflict[],
): readonly SlotName[] {
  if (kind === 'implicit' || kind === 'ambiguous') return []
  const required = REQUIRED_SLOTS[scene] ?? []
  const present = new Set(filled.map((slot) => slot.name))
  const conflicted = new Set(conflicts.map((conflict) => conflict.name))
  return required.filter((name) => !present.has(name) && !conflicted.has(name))
}
