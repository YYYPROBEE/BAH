/**
 * 周期扣款检测（场景 5 §6.2–§6.9）：13 条边界 + 置信度分层 + 三分法 + 核验 + 纯函数。
 */

import { describe, expect, it } from 'vitest'

import { DAY_MS } from '../core/time.ts'
import { bankIds, type CancelRequest, type MerchantAuthorization, type Subscription, type Transaction } from '../core/model.ts'
import { detectRecurring, deriveCutoffFindings } from './recurring.ts'

const NOW = Date.UTC(2026, 9, 30, 2, 0, 0)
const ACCOUNT = bankIds.account('a-1')
const USER = bankIds.user('u-1')

let sequence = 0

function charge(
  name: string,
  at: number,
  amountCents: number,
  overrides: Partial<Transaction> = {},
): Transaction {
  sequence += 1
  return {
    id: bankIds.txn(`t-${sequence}`),
    accountId: ACCOUNT,
    at,
    amountCents,
    direction: 'out',
    counterparty: { name },
    category: 'subscription',
    channel: 'app',
    status: 'success',
    ...overrides,
  }
}

/** 生成一串固定间隔的扣款（最后一条在 `lastAt`）。 */
function series(
  name: string,
  amounts: readonly number[],
  options: { lastAt?: number; intervalDays?: number } = {},
): Transaction[] {
  const lastAt = options.lastAt ?? NOW - DAY_MS
  const interval = options.intervalDays ?? 30
  return amounts.map((amount, index) =>
    charge(name, lastAt - (amounts.length - 1 - index) * interval * DAY_MS, amount),
  )
}

function detect(transactions: readonly Transaction[], windowDays?: number) {
  return detectRecurring(transactions, {
    now: NOW,
    ...(windowDays === undefined ? {} : { windowDays }),
  })
}

/* ── 13 条边界 ─────────────────────────────────────────────────────────────── */

describe('边界 1–2：月末漂移与闰年', () => {
  it('1. 1-31 → 2-28，仍判 monthly；下次扣款回到 3-31', () => {
    const monthEndNow = Date.UTC(2026, 2, 1, 2, 0, 0)
    const txns = [
      charge('视频会员', Date.UTC(2025, 11, 31, 2), 3000),
      charge('视频会员', Date.UTC(2026, 0, 31, 2), 3000),
      charge('视频会员', Date.UTC(2026, 1, 28, 2), 3000),
    ]
    const output = detectRecurring(txns, { now: monthEndNow })
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.cycle).toBe('monthly')
    expect(output.series[0]?.nextChargeAt).toBe(Date.UTC(2026, 2, 31, 2))
  })

  it('2. 闰年 2-29 不产生额外周期', () => {
    const leapNow = Date.UTC(2028, 3, 1, 2, 0, 0)
    const txns = [
      charge('视频会员', Date.UTC(2028, 0, 31, 2), 3000),
      charge('视频会员', Date.UTC(2028, 1, 29, 2), 3000),
      charge('视频会员', Date.UTC(2028, 2, 31, 2), 3000),
    ]
    const output = detectRecurring(txns, { now: leapNow })
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.cycle).toBe('monthly')
    expect(output.series[0]?.nextChargeAt).toBe(Date.UTC(2028, 3, 30, 2))
  })
})

describe('边界 3–5：顺延、涨价、单次购买', () => {
  it('3. 春节月推迟 5 天：中位数稳 → 仍判 monthly（regularity 0.75 → medium）', () => {
    const lastAt = NOW - DAY_MS
    const offsets = [0, 30, 60, 95, 125]
    const txns = offsets.map((offset) => charge('视频会员', lastAt - (125 - offset) * DAY_MS, 3000))
    const output = detect(txns)
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.cycle).toBe('monthly')
    expect(output.series[0]?.confidence).toBe('medium')
  })

  it('4. 30→35 涨价：仍是一条 series，带 priceHike，且按平台段口径判 high', () => {
    const output = detect(series('视频会员', [3000, 3000, 3000, 3500, 3500, 3500]))
    expect(output.series).toHaveLength(1)
    const found = output.series[0]
    expect(found?.instances).toHaveLength(6)
    expect(found?.priceHike).toEqual({ fromCents: 3000, toCents: 3500, at: found?.instances[3]?.at })
    expect(found?.confidence).toBe('high')
  })

  it('5. 同商户月费 30 + 单次购买 300：金额桶分离，单次购买不成 series', () => {
    const txns = [
      ...series('视频会员', [3000, 3000, 3000, 3000], { lastAt: NOW - 31 * DAY_MS }),
      charge('视频会员', NOW - 2 * DAY_MS, 30_000),
    ]
    const output = detect(txns)
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.instances).toHaveLength(4)
    expect(output.series[0]?.amountCents).toBe(3000)
  })
})

describe('边界 6–8：三分法', () => {
  it('6. 房租 4500 每月：检出但 kind=bill，不进订阅清单', () => {
    const output = detect(series('房租-王房东', [450_000, 450_000, 450_000, 450_000, 450_000, 450_000]))
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.kind).toBe('bill')
  })

  it('7. 水电每月波动 20%：kind=bill、confidence=low', () => {
    const output = detect(series('国网电力', [15_500, 20_500, 16_000, 20_000, 15_200, 20_700]))
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.kind).toBe('bill')
    expect(output.series[0]?.confidence).toBe('low')
  })

  it('8. 12 期递减分期（899→800）：kind=installment', () => {
    const amounts = Array.from({ length: 12 }, (_, index) => 89_900 - index * 900)
    const output = detect(series('XX商城分期', amounts), 400)
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.kind).toBe('installment')
  })
})

describe('边界 9–13：试用、重复、脏名、窗口、等额分期', () => {
  it('9. 首期 0 元 → 次期 30 元：0 元不参与金额桶，标 trialConverted', () => {
    const output = detect(series('云存储', [0, 3000, 3000, 3000]))
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.trialConverted).toBe(true)
    expect(output.series[0]?.amountCents).toBe(3000)
    expect(output.series[0]?.instances.every((instance) => instance.amountCents > 0)).toBe(true)
  })

  it('10. 同商户同日同额重复扣款：不算两个周期点，产出 duplicate', () => {
    const txns = [
      charge('云音乐', NOW - 61 * DAY_MS, 1200),
      charge('云音乐', NOW - 60 * DAY_MS, 1200),
      charge('云音乐', NOW - 31 * DAY_MS, 1200),
      charge('云音乐', NOW - DAY_MS, 1200),
    ]
    const output = detect(txns)
    expect(output.duplicates).toHaveLength(1)
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.instances).toHaveLength(3)
  })

  it('11. STM*VIDEO 与视频会员混用：归一化后同一 series', () => {
    const lastAt = NOW - DAY_MS
    const txns = [0, 1, 2, 3, 4, 5].map((index) =>
      charge(
        index < 3 ? 'STM*VIDEO' : '视频会员',
        lastAt - (5 - index) * 30 * DAY_MS,
        3000,
      ),
    )
    const output = detect(txns)
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.merchantKey).toBe('视频会员')
    expect(output.series[0]?.displayName).toBe('视频会员')
  })

  it('12. 180 天窗口边界：第 181 天不参与计算（结果与窗口参数一致）', () => {
    const inside = series('视频会员', [3000, 3000, 3000, 3000])
    const outside = charge('视频会员', NOW - 200 * DAY_MS, 3000)
    const withOutside = detect([...inside, outside])
    const withoutOutside = detect(inside)
    expect(withOutside.basis.txnCount).toBe(withoutOutside.basis.txnCount)
    expect(withOutside.series).toEqual(withoutOutside.series)
  })

  it('已冲正的转出不算扣款（退款流水指向原交易）', () => {
    const txns = series('视频会员', [3000, 3000, 3000, 3000, 3000, 3000])
    const reversedTxnId = txns[1]?.id
    if (reversedTxnId === undefined) throw new Error('夹具缺少第二笔')
    const refund = charge('视频会员', NOW - 5 * DAY_MS, 3000, {
      direction: 'in',
      category: 'refund',
      reversalOf: reversedTxnId,
    })
    const output = detect([...txns, refund])
    expect(output.basis.txnCount).toBe(5)
    expect(output.series[0]?.instances.map((item) => item.txnId)).not.toContain(reversedTxnId)
    expect(output.series[0]?.instances).toHaveLength(5)
  })

  it('13. 12 期等额扣款：kind=subscription + suspectedInstallment，不判分期', () => {
    const output = detect(series('视频会员', Array.from({ length: 12 }, () => 3000)), 400)
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.kind).toBe('subscription')
    expect(output.series[0]?.suspectedInstallment).toBe(true)
  })
})

/* ── 算法细节：离群剪枝 / 降价 / 核验守卫 ────────────────────────────────── */

describe('剪枝与降价', () => {
  it('混入序列的单次购买（同额域但破坏间隔）被剪掉，序列回到 6 笔', () => {
    const monthly = series('视频会员', [3000, 3000, 3000, 3000, 3000, 3000])
    // 6000 是 2× 中位数：通过「一个数量级」过滤，但插在周期中间破坏间隔
    const outlier = charge('视频会员', NOW - 75 * DAY_MS, 6000)
    const output = detect([...monthly, outlier])
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.instances).toHaveLength(6)
    expect(output.series[0]?.amountCents).toBe(3000)
    expect(output.basis.txnCount).toBe(7)
  })

  it('单次购买紧跟月费之后（离群点在区间右侧）也剪掉，不误伤两档月费', () => {
    const monthly = series('视频会员', [3000, 3000, 3000, 3000, 3000, 3000])
    const third = monthly[3]
    const at = (third?.at ?? NOW) + 3 * DAY_MS
    const output = detect([...monthly, charge('视频会员', at, 5500)])
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.instances).toHaveLength(6)
    expect(output.series[0]?.amountCents).toBe(3000)
    expect(output.series[0]?.priceDrop).toBeUndefined()
  })

  it('降价（3000 → 2000）仍是一条 series，带 priceDrop 而不是拆成两条', () => {
    const output = detect(series('视频会员', [3000, 3000, 3000, 2000, 2000, 2000]))
    expect(output.series).toHaveLength(1)
    expect(output.series[0]?.amountCents).toBe(2000)
    expect(output.series[0]?.priceDrop).toMatchObject({ fromCents: 3000, toCents: 2000 })
  })
})

describe('断供核验的守卫', () => {
  it('取消请求指向已不存在的订阅 → 跳过，不产出 finding', () => {
    const findings = deriveCutoffFindings({
      transactions: [charge('视频会员', NOW - 5 * DAY_MS, 3000)],
      cancelRequests: [
        cancelRequest({ subscriptionId: bankIds.subscription('s-404') }),
      ],
      authorizations: [],
      subscriptions: [SUBSCRIPTION],
      now: NOW,
    })
    expect(findings).toHaveLength(0)
  })

  it('协议关闭后的失败扣款不算违约（只认成功的转出）', () => {
    const authorization: MerchantAuthorization = {
      id: bankIds.authorization('auth-1'),
      userId: USER,
      merchant: '视频会员',
      merchantKey: '视频会员',
      agreementNo: 'AG-2026-0001',
      accountId: ACCOUNT,
      status: 'revoked',
      signedAt: NOW - 200 * DAY_MS,
      revokedAt: NOW - 10 * DAY_MS,
    }
    const findings = deriveCutoffFindings({
      transactions: [
        charge('视频会员', NOW - 5 * DAY_MS, 3000, { status: 'failed' }),
      ],
      cancelRequests: [],
      authorizations: [authorization],
      subscriptions: [SUBSCRIPTION],
      now: NOW,
    })
    expect(findings).toHaveLength(0)
  })
})

/* ── 置信度分层与单调性 ───────────────────────────────────────────────────── */

describe('置信度分层', () => {
  it('4 笔稳定月度 → high', () => {
    const output = detect(series('视频会员', [3000, 3000, 3000, 3000]))
    expect(output.series[0]?.confidence).toBe('high')
  })

  it('3 笔稳定月度 → medium', () => {
    const output = detect(series('云音乐', [1200, 1200, 1200]))
    expect(output.series[0]?.confidence).toBe('medium')
  })

  it('2 笔不成 series（不足 3 笔不能证明周期性）', () => {
    const output = detect(series('云音乐', [1200, 1200]))
    expect(output.series).toHaveLength(0)
  })
})

/* ── 断供核验 ─────────────────────────────────────────────────────────────── */

const SUBSCRIPTION: Subscription = {
  id: bankIds.subscription('s-1'),
  userId: USER,
  merchant: '视频会员',
  merchantKey: '视频会员',
  cycle: 'monthly',
  nextChargeAt: NOW + 5 * DAY_MS,
  amountCents: 3000,
  status: 'active',
}

function cancelRequest(patch: Partial<CancelRequest> = {}): CancelRequest {
  return {
    id: bankIds.cancelRequest('cr-1'),
    userId: USER,
    subscriptionId: SUBSCRIPTION.id,
    path: 'merchant',
    mode: 'now',
    requestedAt: NOW - 20 * DAY_MS,
    expectedEffectiveAt: NOW - 20 * DAY_MS,
    verifyBy: NOW - 10 * DAY_MS,
    ...patch,
  }
}

describe('deriveCutoffFindings 断供核验（纯推导）', () => {
  it('核验窗口未到 → pending', () => {
    const findings = deriveCutoffFindings({
      transactions: [],
      cancelRequests: [cancelRequest({ verifyBy: NOW + DAY_MS })],
      authorizations: [],
      subscriptions: [SUBSCRIPTION],
      now: NOW,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.verdict).toBe('pending')
  })

  it('核验窗口过后仍有扣款 → failed（升级争议工单）', () => {
    const findings = deriveCutoffFindings({
      transactions: [charge('视频会员', NOW - 5 * DAY_MS, 3000)],
      cancelRequests: [cancelRequest()],
      authorizations: [],
      subscriptions: [SUBSCRIPTION],
      now: NOW,
    })
    expect(findings[0]?.verdict).toBe('failed')
    expect(findings[0]?.hint).toContain('争议工单')
  })

  it('核验窗口过后无新扣款 → effective', () => {
    const findings = deriveCutoffFindings({
      transactions: [charge('视频会员', NOW - 25 * DAY_MS, 3000)],
      cancelRequests: [cancelRequest()],
      authorizations: [],
      subscriptions: [SUBSCRIPTION],
      now: NOW,
    })
    expect(findings[0]?.verdict).toBe('effective')
  })

  it('协议已关仍扣款 → breached（critical）', () => {
    const authorization: MerchantAuthorization = {
      id: bankIds.authorization('auth-1'),
      userId: USER,
      merchant: '视频会员',
      merchantKey: '视频会员',
      agreementNo: 'AG-2026-0001',
      accountId: ACCOUNT,
      status: 'revoked',
      signedAt: NOW - 200 * DAY_MS,
      revokedAt: NOW - 10 * DAY_MS,
    }
    const findings = deriveCutoffFindings({
      transactions: [charge('视频会员', NOW - 5 * DAY_MS, 3000)],
      cancelRequests: [],
      authorizations: [authorization],
      subscriptions: [SUBSCRIPTION],
      now: NOW,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.verdict).toBe('breached')
    expect(findings[0]?.level).toBe('critical')
  })
})

/* ── 纯函数与确定性 ───────────────────────────────────────────────────────── */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as unknown as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

describe('纯函数与确定性', () => {
  it('同输入两次调用结果全等', () => {
    const txns = series('视频会员', [3000, 3000, 3000, 3500, 3500, 3500])
    expect(detect(txns)).toEqual(detect(txns))
  })

  it('深冻结入参后跑完不抛（证明没有回写）', () => {
    const txns = deepFreeze(series('视频会员', [3000, 3000, 3000, 3000]))
    expect(() => detect(txns)).not.toThrow()
    const frozenRequests = deepFreeze([cancelRequest()])
    const frozenSubscriptions = deepFreeze([SUBSCRIPTION])
    expect(() =>
      deriveCutoffFindings({
        transactions: deepFreeze([charge('视频会员', NOW - 5 * DAY_MS, 3000)]),
        cancelRequests: frozenRequests,
        authorizations: deepFreeze([]),
        subscriptions: frozenSubscriptions,
        now: NOW,
      }),
    ).not.toThrow()
  })

  it('输出按下次扣款日升序（确定性排序）', () => {
    const output = detect([
      ...series('视频会员', [3000, 3000, 3000, 3000], { lastAt: NOW - 10 * DAY_MS }),
      ...series('云音乐', [1200, 1200, 1200], { lastAt: NOW - 20 * DAY_MS }),
    ])
    expect(output.series.map((item) => item.merchantKey).length).toBeGreaterThan(1)
    const dates = output.series.map((item) => item.nextChargeAt)
    expect([...dates].sort((left, right) => left - right)).toEqual(dates)
  })
})
