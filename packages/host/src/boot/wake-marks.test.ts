/**
 * 唤醒标记账本（ADR-0010）的专属用例。
 *
 * 这里是「代签」的唯一凭据面：`plan:dag` 写、`window-signer` 读。判定规则在
 * `@bah/runtime` 的 `decideWindowSign`，本文件只钉记账本身的边界——
 * 尤其是**任何能让标记变松的路径**（同窗口并发、撤销句柄拿错对象、扣预算的非法金额）。
 */

import { captureThrown } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { createWakeMarkStore, type WakeGrant } from './wake-marks.ts'

/** 一份完整凭据（各用例只改自己关心的字段）。 */
function grant(overrides: Partial<WakeGrant> = {}): WakeGrant {
  return {
    windowId: 'w-1',
    planId: 'p-1',
    digest: 'd-1',
    budgetCents: 10_000,
    ...overrides,
  }
}

describe('wake-marks 标记账本', () => {
  it('open 给出只读视图 + take 是唯一记账动作；spentCents 跟着账走', () => {
    const store = createWakeMarkStore()
    const release = store.open(grant())

    const mark = store.get('w-1')
    expect(mark).toBeDefined()
    expect(mark).toMatchObject({ windowId: 'w-1', planId: 'p-1', digest: 'd-1', budgetCents: 10_000 })
    expect(mark?.spentCents).toBe(0)

    expect(mark?.take(4_000)).toBe(true)
    expect(mark?.spentCents).toBe(4_000)
    // 恰好花光预算是合法判决（预算边界取等号）
    expect(mark?.take(6_000)).toBe(true)
    expect(mark?.spentCents).toBe(10_000)

    expect(store.get('w-2')).toBeUndefined()
    release()
  })

  it('超额与非法金额：take 返回 false（不放行），且不消耗预算', () => {
    const store = createWakeMarkStore()
    store.open(grant({ budgetCents: 100 }))
    const mark = store.get('w-1')

    expect(mark?.take(101)).toBe(false)
    expect(mark?.take(100)).toBe(true)
    expect(mark?.take(1)).toBe(false)
    expect(mark?.spentCents).toBe(100)

    // 负数不是"退款"，非整数不是"半分"，NaN 不是"零"——三种都拒绝且不动账
    const fresh = createWakeMarkStore()
    fresh.open(grant({ windowId: 'w-9', budgetCents: 100 }))
    const m9 = fresh.get('w-9')
    expect(m9?.take(-1)).toBe(false)
    expect(m9?.take(0.5)).toBe(false)
    expect(m9?.take(Number.NaN)).toBe(false)
    expect(m9?.take('10' as unknown as number)).toBe(false)
    expect(m9?.spentCents).toBe(0)
    // 0 分是合法扣减（零成本工具也走同一条记账）
    expect(m9?.take(0)).toBe(true)
  })

  it('同一窗口并发唤醒：第二次 open 直接炸，且原标记不受影响', () => {
    const store = createWakeMarkStore()
    const release = store.open(grant())

    const error = captureThrown(() => store.open(grant({ digest: 'd-forged' })))
    expect(error.code).toBe('wake-mark-duplicate')
    expect(error.detail).toMatchObject({ windowId: 'w-1', planId: 'p-1' })

    // 拒绝必须是无副作用的：已开的标记与它的预算一分没动
    expect(store.get('w-1')?.digest).toBe('d-1')
    expect(store.get('w-1')?.take(1)).toBe(true)
    expect(store.get('w-1')?.spentCents).toBe(1)

    release()
    // 撤销后同窗口可以重新武装
    const release2 = store.open(grant({ digest: 'd-2' }))
    expect(store.get('w-1')?.digest).toBe('d-2')
    release2()
  })

  it('撤销句柄只撤销自己那一条：过期句柄不得删掉同窗口的新标记', () => {
    const store = createWakeMarkStore()
    const stale = store.open(grant())
    stale()
    expect(store.get('w-1')).toBeUndefined()
    // 重复撤销是幂等的（finally 里跑两次不该有副作用）
    expect(() => stale()).not.toThrow()

    const current = store.open(grant({ digest: 'd-new' }))
    stale()
    // 旧 run 的 finally 晚到一步，也不能把在途的新标记抹掉
    expect(store.get('w-1')?.digest).toBe('d-new')
    current()
    expect(store.get('w-1')).toBeUndefined()
  })

  it('不同窗口各记各的账（预算不跨窗口串用）', () => {
    const store = createWakeMarkStore()
    store.open(grant({ windowId: 'w-a', budgetCents: 100 }))
    store.open(grant({ windowId: 'w-b', budgetCents: 100 }))

    expect(store.get('w-a')?.take(100)).toBe(true)
    expect(store.get('w-a')?.take(1)).toBe(false)
    expect(store.get('w-b')?.spentCents).toBe(0)
    expect(store.get('w-b')?.take(100)).toBe(true)
  })

  it('可选凭据字段原样透传（红级代签要看 verifiedAt / expiresAt）', () => {
    const store = createWakeMarkStore()
    store.open(grant({ verifiedAt: 1_000, expiresAt: 2_000 }))
    expect(store.get('w-1')).toMatchObject({ verifiedAt: 1_000, expiresAt: 2_000 })
  })
})
