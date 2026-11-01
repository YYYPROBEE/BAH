/**
 * 「即将扣款」清单的收敛性（同刻到期时的稳定序）。
 *
 * 排序键是 `nextChargeAt` 升序，**同刻再按 `subscriptionId` 升序**。
 * 第二条不能省：扣款日经常撞在一起（同一天到期的两家会员），而比较器返回 0 时
 * 的顺序由实现决定。这条判据写成恒等式而不是"我以为的顺序"：
 * 输入怎么排列，输出必须是同一条——快照与回放靠它才可重算（订阅卡片的
 * 「下列前 N 项」也取的是这个序，错一位就是两张不同的清单）。
 */

import { describe, expect, it } from 'vitest'

import { upcomingBlockOf } from './subscriptions.ts'

import type { SnapshotItem, SubscriptionSnapshot } from './subscriptions.ts'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** 造一条订阅条目。 */
function item(subscriptionId: string, nextChargeAt: number, amountCents = 3_500): SnapshotItem {
  return {
    subscriptionId,
    merchant: `商户-${subscriptionId}`,
    amountCents,
    nextChargeAt,
    status: 'active',
  }
}

/** 造一个快照：窗口基准是事件自己的 `at`，不是墙上时钟。 */
function snapshotOf(items: readonly SnapshotItem[]): SubscriptionSnapshot {
  return {
    at: T0,
    detectedAt: T0,
    basisFrom: T0 - 30 * DAY,
    basisTo: T0,
    txnCount: 42,
    items,
  }
}

/** 表格第一列（商户名，用来读顺序）。 */
function merchantsOf(items: readonly SnapshotItem[]): string[] {
  return upcomingBlockOf(snapshotOf(items)).rows.map((row) => String(row[0]))
}

describe('upcomingBlockOf · 稳定序', () => {
  it('同一天到期的三条：三种输入排列收敛到同一张表（按 subscriptionId 升序）', () => {
    const due = T0 + 2 * DAY
    const a = item('s-video', due)
    const b = item('s-bike', due)
    const c = item('s-cloud', due)

    const expected = ['商户-s-bike', '商户-s-cloud', '商户-s-video']
    for (const input of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
    ]) {
      expect(merchantsOf(input)).toEqual(expected)
    }
  })

  it('日期是主键：更晚到期的排后面，即便它的 ID 字典序更小', () => {
    expect(
      merchantsOf([
        item('s-a', T0 + 5 * DAY),
        item('s-z', T0 + 1 * DAY),
        item('s-m', T0 + 1 * DAY),
      ]),
    ).toEqual(['商户-s-m', '商户-s-z', '商户-s-a'])
  })

  it('顺序改变不影响集合与合计：摘要与行表在两种排列下逐字相同', () => {
    const items = [item('s-b', T0 + 1 * DAY, 1_000), item('s-a', T0 + 1 * DAY, 2_000)]
    const forward = upcomingBlockOf(snapshotOf(items))
    const reversed = upcomingBlockOf(snapshotOf([...items].reverse()))

    expect(forward.summary).toBe(reversed.summary)
    expect(forward.rows).toEqual(reversed.rows)
    expect(forward.rows.map((row) => row[0])).toEqual(['商户-s-a', '商户-s-b'])
  })

  it('非 active / 窗口外 / 超出提醒提前量的条目不进表（同刻排序只在入选者之间谈）', () => {
    const due = T0 + 2 * DAY
    expect(
      merchantsOf([
        item('s-in', due),
        { ...item('s-paused', due), status: 'paused' },
        item('s-late', T0 + 40 * DAY),
        item('s-ahead', T0 + 4 * DAY, 3_500),
      ]),
    ).toEqual(['商户-s-in', '商户-s-ahead'])
  })
})
