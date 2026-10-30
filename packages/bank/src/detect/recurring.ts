/**
 * 周期扣款检测（场景 5 §6.2–§6.9）。
 *
 * **纯函数**：零 IO、零时钟、不修改入参。输入 `Transaction[]`，输出推断结果；
 * 推断永不写进账本（`docs/roadmap.md:65`：「识别是推断，不能当事实写进账本」）。
 *
 * 为什么要在代码里算而不是让模型扫账单：上下文只注入 3 条流水（`context/slots.ts:60`），
 * 模型根本看不到 180 天账单。检测在代码里做、结果结构化注入，模型只负责叙述。
 */

import type {
  AuthorizationId,
  CancelRequest,
  CancelVerdict,
  ChargeCycle,
  Confidence,
  MerchantAuthorization,
  RecurringSeries,
  Subscription,
  SubscriptionId,
  Transaction,
  TxnId,
} from '../core/model.ts'
import { DAY_MS } from '../core/time.ts'
import { normalizeMerchant } from './merchant.ts'

/**
 * 算法参数（**不是部署旋钮**）。
 *
 * 集中登记以避免散落；`verify-no-hardcoded-config` 只扫 `packages/safety/src`，
 * 本模块不在其扫描面，但仍按「阈值唯一登记」的纪律集中在这里。
 */
export const DETECT_DEFAULTS = {
  /** 6 个月足以覆盖季度扣款 3 笔。 */
  windowDays: 180,
  /** 覆盖周末/节假日顺延。 */
  intervalToleranceDays: 3,
  /** 涨价 1 元在 20 元月费上即 5%。 */
  amountTolerancePct: 0.05,
  /** 小额订阅的绝对容差（分）。 */
  amountToleranceCents: 200,
  /** 少于 3 笔无法证明周期性（2 笔走 duplicate 特判）。 */
  minCharges: 3,
  /** 自动入册的门槛比候选更高（季度降为 3）。 */
  minChargesHigh: 4,
  minChargesHighQuarterly: 3,
  /** 低于此值不判周期。 */
  minRegularity: 0.75,
  /** 平台段 > 2 = 金额反复跳变。 */
  maxPlateaus: 2,
  /** **段内** CV，不是整段 CV。 */
  plateauCvHigh: 0.03,
  plateauCvMedium: 0.05,
  /** 双阈值取「同时满足」。 */
  priceHikePct: 0.05,
  priceHikeCents: 200,
  /** 与 bill 的 duplicate 语义对齐。 */
  duplicateWindowDays: 2,
} as const

/** 检测器版本：落进事件载荷，回放时能识别这是哪一版推断。 */
export const DETECTOR_VERSION = 'recurring/1'

/** 检测输入参数。 */
export interface DetectOptions {
  readonly now: number
  readonly windowDays?: number
  /** 事实库（用于给推断结果对上 `subscriptionId`）；缺省不对照。 */
  readonly subscriptions?: readonly Subscription[]
}

/** 一次检测的取证边界（事件载荷用）。 */
export interface DetectBasis {
  readonly from: number
  readonly to: number
  readonly txnCount: number
}

/** 重复扣款（同商户、同金额、间隔 ≤2 天）。 */
export interface DuplicateCharge {
  readonly merchantKey: string
  readonly displayName: string
  readonly amountCents: number
  readonly firstTxnId: TxnId
  readonly txnId: TxnId
  readonly at: number
}

/** 检测产出。 */
export interface DetectOutput {
  readonly series: readonly RecurringSeries[]
  readonly duplicates: readonly DuplicateCharge[]
  readonly basis: DetectBasis
}

/** 内部：一笔候选扣款。 */
interface Charge {
  readonly txnId: TxnId
  readonly at: number
  readonly amountCents: number
}

/** 内部：金额桶。 */
interface AmountBucket {
  readonly instances: Charge[]
}

/** 内部：合并涨价后的候选段。 */
interface SeriesCandidate {
  readonly instances: Charge[]
  readonly hike?: { fromCents: number; toCents: number; at: number }
  readonly drop?: { fromCents: number; toCents: number; at: number }
}

/** 检测主入口。 */
export function detectRecurring(
  transactions: readonly Transaction[],
  options: DetectOptions,
): DetectOutput {
  const windowDays = options.windowDays ?? DETECT_DEFAULTS.windowDays
  const to = options.now
  const from = to - windowDays * DAY_MS
  // 已冲正的转出不再算扣款：否则「退款后仍被视为订阅在扣」会虚构周期
  const reversed = new Set(
    transactions
      .filter(
        (item) =>
          item.status === 'success' &&
          item.direction === 'in' &&
          item.category === 'refund' &&
          item.reversalOf !== undefined,
      )
      .map((item) => String(item.reversalOf)),
  )
  const eligible = transactions.filter(
    (item) =>
      item.status === 'success' &&
      item.direction === 'out' &&
      item.at >= from &&
      item.at <= to &&
      item.amountCents >= 0 &&
      !reversed.has(String(item.id)),
  )

  const groups = new Map<string, { rawNames: Set<string>; charges: Charge[] }>()
  for (const item of eligible) {
    const key = normalizeMerchant(item.counterparty.name)
    if (key.length === 0) continue
    const group = groups.get(key) ?? { rawNames: new Set<string>(), charges: [] }
    group.rawNames.add(item.counterparty.name)
    group.charges.push({ txnId: item.id, at: item.at, amountCents: item.amountCents })
    groups.set(key, group)
  }

  const series: RecurringSeries[] = []
  const duplicates: DuplicateCharge[] = []

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)
    if (group === undefined) continue
    const displayName = pickDisplayName([...group.rawNames])
    const sorted = [...group.charges].sort((left, right) => left.at - right.at || compareId(left.txnId, right.txnId))

    const collapsed = collapseDuplicates(sorted, key, displayName)
    duplicates.push(...collapsed.duplicates)
    let charges = collapsed.kept
    let trialConverted = false
    if (charges.some((charge) => charge.amountCents === 0)) {
      const positive = charges.filter((charge) => charge.amountCents > 0)
      if (positive.length === 0) continue
      // 首期 0 元试用：0 元不参与金额桶，从首个非 0 元起算
      trialConverted = charges[0]?.amountCents === 0
      charges = positive
    }
    if (charges.length < DETECT_DEFAULTS.minCharges) continue

    // 极端金额离群点（单次购买）先出局：金额与中位数差一个数量级时不参与序列；
    // 水电式的 ±20% 波动不受影响（仍在 0.5×–2× 区间内）。
    const inFamily = dropExtremeOutliers(charges)
    if (inFamily.length < DETECT_DEFAULTS.minCharges) continue

    // 主路径：整组剪除「金额离群且破坏间隔」的点（单次购买混在订阅里）。
    // 金额波动本身不剪（水电月月不同，但间隔仍是月度）。
    const pruned = pruneAmountOutliers(inFamily)
    const built: RecurringSeries[] = []
    const whole = buildSeries({ instances: pruned }, { merchantKey: key, displayName, trialConverted, subscriptions: options.subscriptions })
    if (whole !== undefined) built.push(whole)

    // 兜底：同商户可能有两档并存的月费（30 与 60 交替），整组剪枝只会留下其中一档；
    // 金额桶能拆开两档，互不覆盖。
    const buckets = bucketByAmount(inFamily)
    const candidates = buckets
      .filter((bucket) => bucket.instances.length >= DETECT_DEFAULTS.minCharges)
      .map((bucket) => ({ instances: bucket.instances }))
      .sort((left, right) => (left.instances[0]?.at ?? 0) - (right.instances[0]?.at ?? 0))
    for (const candidate of mergePriceSteps(candidates)) {
      const series = buildSeries(candidate, { merchantKey: key, displayName, trialConverted, subscriptions: options.subscriptions })
      if (series !== undefined) built.push(series)
    }

    // 同一组流水只保留一条（主路径优先）
    const seen = new Set<string>()
    for (const item of built) {
      const signature = item.instances.map((instance) => instance.txnId).join('|')
      if (seen.has(signature)) continue
      seen.add(signature)
      series.push(item)
    }
  }

  series.sort(
    (left, right) =>
      left.nextChargeAt - right.nextChargeAt ||
      right.amountCents - left.amountCents ||
      (left.merchantKey < right.merchantKey ? -1 : left.merchantKey > right.merchantKey ? 1 : 0),
  )
  return {
    series,
    duplicates: duplicates.sort((left, right) => right.at - left.at),
    basis: { from, to, txnCount: eligible.length },
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 候选生成
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 同商户同金额、间隔 ≤2 天的第二笔视为重复扣款：不算两个周期点。
 *
 * 只看**已保留**的上一笔：三笔同日同额时，第二、三笔都记为 duplicate。
 */
function collapseDuplicates(
  charges: readonly Charge[],
  merchantKey: string,
  displayName: string,
): { kept: Charge[]; duplicates: DuplicateCharge[] } {
  const kept: Charge[] = []
  const duplicates: DuplicateCharge[] = []
  const windowMs = DETECT_DEFAULTS.duplicateWindowDays * DAY_MS
  for (const charge of charges) {
    const original = [...kept]
      .reverse()
      .find((item) => charge.at - item.at <= windowMs && item.amountCents === charge.amountCents)
    if (original !== undefined && original.amountCents > 0) {
      duplicates.push({
        merchantKey,
        displayName,
        amountCents: charge.amountCents,
        firstTxnId: original.txnId,
        txnId: charge.txnId,
        at: charge.at,
      })
      continue
    }
    kept.push(charge)
  }
  return { kept, duplicates }
}

/** 金额桶：按中位数 ±max(5%, 200 分) 聚类；跨桶不合并。 */
function bucketByAmount(charges: readonly Charge[]): AmountBucket[] {
  const buckets: { instances: Charge[]; amounts: number[] }[] = []
  for (const charge of charges) {
    let best: { instances: Charge[]; amounts: number[] } | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const bucket of buckets) {
      const median = medianOf(bucket.amounts)
      const distance = Math.abs(charge.amountCents - median)
      if (distance <= amountTolerance(median) && distance < bestDistance) {
        best = bucket
        bestDistance = distance
      }
    }
    if (best !== undefined) {
      best.instances.push(charge)
      best.amounts.push(charge.amountCents)
    } else {
      buckets.push({ instances: [charge], amounts: [charge.amountCents] })
    }
  }
  return buckets.map((bucket) => ({
    instances: [...bucket.instances].sort(
      (left, right) => left.at - right.at || compareId(left.txnId, right.txnId),
    ),
  }))
}

/**
 * 涨价台阶合并（§6.2 ③b）：不做这步，一次涨价会被拆成两个订阅。
 *
 * 相邻两桶同时满足：首尾相接（B 首笔 ≈ A 末笔 + medianΔ，±3 天）、无交错、单向。
 */
function mergePriceSteps(buckets: readonly SeriesCandidate[]): SeriesCandidate[] {
  const merged: SeriesCandidate[] = []
  for (const bucket of buckets) {
    const previous = merged[merged.length - 1]
    if (previous === undefined) {
      merged.push({ instances: [...bucket.instances] })
      continue
    }
    const previousLast = previous.instances[previous.instances.length - 1]
    const nextFirst = bucket.instances[0]
    if (previousLast === undefined || nextFirst === undefined || previousLast.at >= nextFirst.at) {
      merged.push({ instances: [...bucket.instances] })
      continue
    }
    const medianDays = medianIntervalDays(previous.instances)
    const gapDays = (nextFirst.at - previousLast.at) / DAY_MS
    if (
      medianDays === undefined ||
      Math.abs(gapDays - medianDays) > DETECT_DEFAULTS.intervalToleranceDays
    ) {
      merged.push({ instances: [...bucket.instances] })
      continue
    }
    const previousAmounts = previous.instances.map((charge) => charge.amountCents)
    const nextAmounts = bucket.instances.map((charge) => charge.amountCents)
    const increasing = nextAmounts.every((amount) => amount >= Math.max(...previousAmounts))
    const decreasing = nextAmounts.every((amount) => amount <= Math.min(...previousAmounts))
    if (!increasing && !decreasing) {
      merged.push({ instances: [...bucket.instances] })
      continue
    }
    const fromCents = Math.round(medianOf(previousAmounts))
    const toCents = Math.round(medianOf(nextAmounts))
    const instances = [...previous.instances, ...bucket.instances].sort(
      (left, right) => left.at - right.at || compareId(left.txnId, right.txnId),
    )
    merged[merged.length - 1] = {
      instances,
      ...(increasing
        ? { hike: { fromCents, toCents, at: nextFirst.at } }
        : { drop: { fromCents, toCents, at: nextFirst.at } }),
    }
  }
  return merged
}

/* ────────────────────────────────────────────────────────────────────────────
 * 序列判定
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 剪除与中位数差一个数量级的扣款（0.5×–2× 之外）。
 *
 * 一次涨价的幅度通常在一倍以内，仍留在序列里由平台段处理；而「月费 30 + 单次购买 300」
 * 这种 10 倍差是两类业务，不该混成一条订阅。
 */
function dropExtremeOutliers(charges: readonly Charge[]): Charge[] {
  const median = medianOf(charges.map((charge) => charge.amountCents))
  if (median <= 0) return [...charges]
  return charges.filter(
    (charge) => charge.amountCents >= median * 0.5 && charge.amountCents <= median * 2,
  )
}

/**
 * 剪除「金额离群且破坏间隔」的扣款（单次购买混在订阅序列里）。
 *
 * 只剪**两个条件同时成立**的点：它造成间隔离群，且金额远离中位数。
 * 时间漂移（春节顺延）金额正常 → 不剪；水电金额波动但间隔正常 → 不剪。
 */
function pruneAmountOutliers(charges: readonly Charge[]): Charge[] {
  let kept = [...charges]
  for (let guard = 0; guard < charges.length; guard += 1) {
    if (kept.length < DETECT_DEFAULTS.minCharges) break
    const intervals: number[] = []
    for (let index = 1; index < kept.length; index += 1) {
      const previous = kept[index - 1]
      const current = kept[index]
      if (previous === undefined || current === undefined) continue
      intervals.push((current.at - previous.at) / DAY_MS)
    }
    if (intervals.length === 0) break
    const medianDays = medianOf(intervals)
    let worstIndex = -1
    let worstDeviation = 0
    for (let index = 0; index < intervals.length; index += 1) {
      const deviation = Math.abs((intervals[index] ?? 0) - medianDays)
      if (deviation > DETECT_DEFAULTS.intervalToleranceDays && deviation > worstDeviation) {
        worstIndex = index
        worstDeviation = deviation
      }
    }
    if (worstIndex === -1) break
    const medianAmount = medianOf(kept.map((charge) => charge.amountCents))
    const tolerance = amountTolerance(medianAmount)
    const left = kept[worstIndex]
    const right = kept[worstIndex + 1]
    if (left === undefined || right === undefined) break
    const leftDeviation = Math.abs(left.amountCents - medianAmount)
    const rightDeviation = Math.abs(right.amountCents - medianAmount)
    const removable = [left, right].filter((charge) => {
      const deviation = Math.abs(charge.amountCents - medianAmount)
      return deviation > tolerance
    })
    if (removable.length === 0) break
    const target =
      leftDeviation >= rightDeviation && leftDeviation > tolerance
        ? left
        : rightDeviation > tolerance
          ? right
          : undefined
    if (target === undefined) break
    kept = kept.filter((charge) => charge.txnId !== target.txnId)
  }
  return kept
}

interface BuildContext {
  readonly merchantKey: string
  readonly displayName: string
  readonly trialConverted: boolean
  readonly subscriptions?: readonly Subscription[]
}

function buildSeries(candidate: SeriesCandidate, context: BuildContext): RecurringSeries | undefined {
  const instances = candidate.instances
  if (instances.length < DETECT_DEFAULTS.minCharges) return undefined

  const intervals: number[] = []
  for (let index = 1; index < instances.length; index += 1) {
    const previous = instances[index - 1]
    const current = instances[index]
    if (previous === undefined || current === undefined) continue
    intervals.push((current.at - previous.at) / DAY_MS)
  }
  if (intervals.length === 0) return undefined
  const medianDays = medianOf(intervals)
  const cycle = classifyCycle(medianDays)
  if (cycle === undefined) return undefined

  const stableCount = intervals.filter(
    (interval) => Math.abs(interval - medianDays) <= DETECT_DEFAULTS.intervalToleranceDays,
  ).length
  const regularity = stableCount / intervals.length
  if (regularity < DETECT_DEFAULTS.minRegularity) return undefined

  const amounts = instances.map((charge) => charge.amountCents)
  const plateaus = plateauSegments(instances, amountTolerance(medianOf(amounts)))
  const maxCv = Math.max(...plateaus.map((plateau) => coefficientOfVariation(plateau.amounts)))
  const weeklyQuarterly = cycle === 'quarterly'
  const highFloor = weeklyQuarterly
    ? DETECT_DEFAULTS.minChargesHighQuarterly
    : DETECT_DEFAULTS.minChargesHigh

  let confidence: Confidence
  if (
    instances.length >= highFloor &&
    regularity === 1 &&
    plateaus.length <= DETECT_DEFAULTS.maxPlateaus &&
    maxCv <= DETECT_DEFAULTS.plateauCvHigh
  ) {
    confidence = 'high'
  } else if (
    plateaus.length >= 3 ||
    maxCv > DETECT_DEFAULTS.plateauCvMedium
  ) {
    confidence = 'low'
  } else {
    confidence = 'medium'
  }

  const kind = classifyKind(instances, context.merchantKey, context.displayName, plateaus.length)
  const equalAmounts = amounts.every((amount) => amount === amounts[0])
  const suspectedInstallment =
    equalAmounts && [6, 12, 24].includes(instances.length) ? true : undefined
  const step = plateauStep(plateaus)
  const hike =
    candidate.hike ??
    step.hike ??
    (plateaus.length <= DETECT_DEFAULTS.maxPlateaus ? trailingHike(instances) : undefined)
  const drop = candidate.drop ?? step.drop
  const nextChargeAt = predictNextCharge(instances, cycle, medianDays)
  const matchedSubscriptionId = context.subscriptions?.find(
    (subscription) =>
      normalizeMerchant(subscription.merchantKey ?? subscription.merchant) === context.merchantKey,
  )?.id

  return {
    merchantKey: context.merchantKey,
    displayName: context.displayName,
    kind,
    cycle,
    amountCents: amounts[amounts.length - 1] ?? 0,
    instances,
    confidence,
    nextChargeAt,
    ...(hike === undefined ? {} : { priceHike: hike }),
    ...(drop === undefined ? {} : { priceDrop: drop }),
    ...(suspectedInstallment === undefined ? {} : { suspectedInstallment }),
    ...(context.trialConverted ? { trialConverted: true } : {}),
    ...(matchedSubscriptionId === undefined ? {} : { matchedSubscriptionId }),
  }
}

function classifyCycle(medianDays: number): ChargeCycle | undefined {
  if (medianDays >= 6 && medianDays <= 8) return 'weekly'
  if (medianDays >= 27 && medianDays <= 32) return 'monthly'
  if (medianDays >= 85 && medianDays <= 95) return 'quarterly'
  return undefined
}

/** 平台段：相邻同额（容差内）为一段；段数 ≥3 = 金额反复跳变。 */
function plateauSegments(
  instances: readonly Charge[],
  tolerance: number,
): { amounts: number[]; firstAt: number }[] {
  const plateaus: { amounts: number[]; firstAt: number }[] = []
  let current: { amounts: number[]; firstAt: number } | undefined
  for (const charge of instances) {
    const previous = current?.amounts[current.amounts.length - 1]
    if (current === undefined) {
      current = { amounts: [charge.amountCents], firstAt: charge.at }
      continue
    }
    if (previous === undefined || Math.abs(charge.amountCents - previous) <= tolerance) {
      current.amounts.push(charge.amountCents)
      continue
    }
    plateaus.push(current)
    current = { amounts: [charge.amountCents], firstAt: charge.at }
  }
  if (current !== undefined) plateaus.push(current)
  return plateaus
}

/** 两个平台段之间的涨价/降价台阶（段数 >2 视为抖动，不报价格突变）。 */
function plateauStep(
  plateaus: readonly { amounts: number[]; firstAt: number }[],
): {
  hike?: { fromCents: number; toCents: number; at: number }
  drop?: { fromCents: number; toCents: number; at: number }
} {
  if (plateaus.length !== 2) return {}
  const first = plateaus[0]
  const second = plateaus[1]
  if (first === undefined || second === undefined) return {}
  const from = medianOf(first.amounts)
  const to = medianOf(second.amounts)
  if (from <= 0) return {}
  if (to - from > DETECT_DEFAULTS.priceHikeCents && (to - from) / from >= DETECT_DEFAULTS.priceHikePct) {
    return { hike: { fromCents: Math.round(from), toCents: Math.round(to), at: second.firstAt } }
  }
  if (from - to > DETECT_DEFAULTS.priceHikeCents && (from - to) / from >= DETECT_DEFAULTS.priceHikePct) {
    return { drop: { fromCents: Math.round(from), toCents: Math.round(to), at: second.firstAt } }
  }
  return {}
}

function coefficientOfVariation(values: readonly number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (mean === 0) return 0
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length
  return Math.sqrt(variance) / mean
}

/** 语义三分法（§6.3）：强信号优先，`kind` 不影响是否检出。 */
function classifyKind(
  instances: readonly Charge[],
  merchantKey: string,
  displayName: string,
  plateauCount: number,
): RecurringSeries['kind'] {
  const text = `${merchantKey}${displayName}`
  const amounts = instances.map((charge) => charge.amountCents)
  const first = amounts[0] ?? 0
  const last = amounts[amounts.length - 1] ?? 0
  const nonIncreasing = amounts.every((amount, index) => index === 0 || amount <= (amounts[index - 1] ?? 0))
  if ((nonIncreasing && first > 0 && (first - last) / first >= 0.05) || includesAny(text, ['分期', '花呗', '白条'])) {
    return 'installment'
  }
  if (
    includesAny(text, ['房租', '租金', '水电', '水费', '电费', '电力', '电网', '燃气', '物业', '宽带', '保险', '话费'])
  ) {
    return 'bill'
  }
  if (
    includesAny(text, ['会员', '视频', '音乐', '云', '存储', '软件', '课程', '健身', '训练', '网盘', '阅读'])
  ) {
    return 'subscription'
  }
  return plateauCount <= DETECT_DEFAULTS.maxPlateaus ? 'subscription' : 'bill'
}

function includesAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword))
}

/** 最近一期较前几期中位数涨价：>200 分且 ≥5%（双阈值同时满足）。 */
function trailingHike(instances: readonly Charge[]): { fromCents: number; toCents: number; at: number } | undefined {
  if (instances.length < 2) return undefined
  const last = instances[instances.length - 1]
  if (last === undefined) return undefined
  const previous = instances.slice(0, -1).map((charge) => charge.amountCents)
  const baseline = medianOf(previous)
  const delta = last.amountCents - baseline
  if (delta > DETECT_DEFAULTS.priceHikeCents && delta / baseline >= DETECT_DEFAULTS.priceHikePct) {
    return { fromCents: Math.round(baseline), toCents: last.amountCents, at: last.at }
  }
  return undefined
}

/**
 * 下次扣款预测（§6.6）：月度按 UTC 日历月推进，且 day 钳到该月最后一天。
 *
 * 锚点取**首笔**的日：1-31 → 2-28 → 3-31，不能从 2-28 推出 3-28。
 */
function predictNextCharge(
  instances: readonly Charge[],
  cycle: ChargeCycle,
  medianDays: number,
): number {
  const first = instances[0]
  const last = instances[instances.length - 1]
  if (first === undefined || last === undefined) return 0
  if (cycle !== 'monthly') return last.at + Math.round(medianDays * DAY_MS)

  const firstDate = new Date(first.at)
  const lastDate = new Date(last.at)
  const anchorDay = firstDate.getUTCDate()
  const lastDay = lastDate.getUTCDate()
  // 只有「末笔被短月钳过」才回用首笔日（1-31 → 2-28 → 3-31）；
  // 按 30 天步进自然漂移的序列，末笔日才是正确的锚（否则会被推回月初）
  const clamped = lastDay < anchorDay && daysInUtcMonth(lastDate.getUTCFullYear(), lastDate.getUTCMonth()) < anchorDay
  const dayAnchor = clamped ? anchorDay : lastDay
  const hour = lastDate.getUTCHours()
  const minute = lastDate.getUTCMinutes()
  const second = lastDate.getUTCSeconds()
  const millisecond = lastDate.getUTCMilliseconds()
  const nextMonth = lastDate.getUTCMonth() + 1
  const year = lastDate.getUTCFullYear() + Math.floor(nextMonth / 12)
  const month = nextMonth % 12
  const day = Math.min(dayAnchor, daysInUtcMonth(year, month))
  return Date.UTC(year, month, day, hour, minute, second, millisecond)
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/* ────────────────────────────────────────────────────────────────────────────
 * 断供核验（§6.7）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 核验输入（纯函数；不改任何实体）。 */
export interface CutoffInput {
  readonly transactions: readonly Transaction[]
  readonly cancelRequests: readonly CancelRequest[]
  readonly authorizations: readonly MerchantAuthorization[]
  readonly subscriptions: readonly Subscription[]
  readonly now: number
}

/** 一条核验发现。 */
export interface CutoffFinding {
  readonly kind: 'cancel' | 'authorization'
  readonly verdict: CancelVerdict
  readonly subscriptionId?: SubscriptionId
  readonly authorizationId?: AuthorizationId
  readonly merchantKey: string
  readonly level?: 'critical'
  readonly hint: string
  /** 核验窗口截止（`pending` 时为 `verifyBy`）。 */
  readonly dueAt: number
}

/**
 * 推导断供核验结论。
 *
 * `CancelRequest` 只持久化「用户提交过取消」；**生效与否每次现算**——
 * 推导可重算，事实不可重写（审查 D-01）。
 */
export function deriveCutoffFindings(input: CutoffInput): readonly CutoffFinding[] {
  const subscriptions = new Map(input.subscriptions.map((subscription) => [String(subscription.id), subscription]))
  const findings: CutoffFinding[] = []

  for (const request of input.cancelRequests) {
    const subscription = subscriptions.get(String(request.subscriptionId))
    if (subscription === undefined) continue
    const merchantKey = normalizeMerchant(subscription.merchantKey ?? subscription.merchant)
    if (input.now <= request.verifyBy) {
      findings.push({
        kind: 'cancel',
        verdict: 'pending',
        subscriptionId: request.subscriptionId,
        merchantKey,
        hint: '核验窗口未到，继续观察下一期扣款',
        dueAt: request.verifyBy,
      })
      continue
    }
    const charged = hasChargesAfter(input.transactions, merchantKey, request.expectedEffectiveAt, input.now)
    findings.push({
      kind: 'cancel',
      verdict: charged ? 'failed' : 'effective',
      subscriptionId: request.subscriptionId,
      merchantKey,
      ...(charged ? { hint: '已提交取消但仍扣款，升级争议工单' } : { hint: '核验窗口内无新扣款，取消已生效' }),
      dueAt: request.verifyBy,
    })
  }

  for (const authorization of input.authorizations) {
    if (authorization.status !== 'revoked' || authorization.revokedAt === undefined) continue
    const charged = hasChargesAfter(
      input.transactions,
      authorization.merchantKey,
      authorization.revokedAt,
      input.now,
    )
    if (!charged) continue
    findings.push({
      kind: 'authorization',
      verdict: 'breached',
      authorizationId: authorization.id,
      merchantKey: authorization.merchantKey,
      level: 'critical',
      hint: '协议已关仍扣款，走争议工单',
      dueAt: authorization.revokedAt,
    })
  }

  return findings
}

function hasChargesAfter(
  transactions: readonly Transaction[],
  merchantKey: string,
  after: number,
  now: number,
): boolean {
  return transactions.some(
    (item) =>
      item.status === 'success' &&
      item.direction === 'out' &&
      item.at > after &&
      item.at <= now &&
      normalizeMerchant(item.counterparty.name) === merchantKey,
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * 小工具
 * ──────────────────────────────────────────────────────────────────────────── */

function amountTolerance(median: number): number {
  return Math.max(median * DETECT_DEFAULTS.amountTolerancePct, DETECT_DEFAULTS.amountToleranceCents)
}

/** 展示名：优先中文、无渠道前缀/括号/数字的名字；同分取更短。 */
function pickDisplayName(names: readonly string[]): string {
  const scored = names.map((name) => {
    const lowered = name.toLowerCase()
    let score = 0
    if (/\p{Script=Han}/u.test(name)) score += 2
    if (!/^(stm|支付宝-|财付通-|微信支付-|快捷支付-|银联-)/i.test(lowered)) score += 2
    if (!/[()（）]/.test(name)) score += 1
    if (!/\d/.test(name)) score += 1
    return { name, score }
  })
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.name.length - right.name.length ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  )
  return scored[0]?.name ?? ''
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function medianIntervalDays(instances: readonly Charge[]): number | undefined {
  const intervals: number[] = []
  for (let index = 1; index < instances.length; index += 1) {
    const previous = instances[index - 1]
    const current = instances[index]
    if (previous === undefined || current === undefined) continue
    intervals.push((current.at - previous.at) / DAY_MS)
  }
  return intervals.length === 0 ? undefined : medianOf(intervals)
}

function compareId(left: TxnId, right: TxnId): number {
  return left < right ? -1 : left > right ? 1 : 0
}
