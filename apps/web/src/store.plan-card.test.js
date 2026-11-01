/**
 * `plan-card` 帧的仓库键（G7 计划卡 × 前端唯一 store）。
 *
 * `@bah/channels/web` 的 `frameKey` 给计划卡的键是 `plan-card:<windowId>`，
 * 语义写在 `frames.ts` 里："一个窗口一张卡（跨 turn 存活；撤销与唤醒都是替换语义）"。
 * store.js 自己有一份**同名同义**的 JS 实现（前端不 import 服务端包），
 * 两份实现必须逐键一致——`store.test.js` 已经为 choice/goal/todo/effects 钉过这条对齐，
 * 本文件把缺的 `plan-card` 补上。
 *
 * 不一致的后果是可见的：桌面 `main.js` 与移动 `shell.js` 都按 `viewKey` upsert，
 * 键退化成 `unknown:<seq>` 后，同一个窗口从"武装"到"到期唤醒"再到"撤销"会
 * 在对话流里留下三张卡，而已经撤销的那张永远不会被替换掉。
 */

import { describe, expect, it } from 'vitest'

import { createStore, frameKey, viewKey } from './store.js'

/** 造一条计划卡帧（字段与 `PlanCardFrame` 同形）。 */
function planCard(seq, windowId, state) {
  return {
    kind: 'plan-card',
    seq,
    at: 1_700_000_000_000 + seq,
    windowId,
    planId: 'p-g7',
    title: '每天替我买咖啡',
    tier: 'standard',
    budgetText: '¥30',
    dueAt: 1_700_000_060_000,
    occurrence: '2026-10',
    state,
    conditions: [{ kind: 'balance-at-least', expected: '¥200', state: 'unknown' }],
    nodeCount: 2,
    digest: 'digest-x',
  }
}

describe('store · plan-card 键', () => {
  it('仓库键 = plan-card:<windowId>（与服务端 frameKey 同口径，不带 seq）', () => {
    expect(frameKey(planCard(11, 'win-a', 'armed'))).toBe('plan-card:win-a')
    expect(frameKey(planCard(12, 'win-a', 'cancelled'))).toBe('plan-card:win-a')
    expect(frameKey(planCard(11, 'win-a', 'armed'))).toBe(frameKey(planCard(99, 'win-a', 'due')))
  })

  it('视图键同样按窗口分键（桌面 main.js / 移动 shell.js 都靠它 upsert）', () => {
    expect(viewKey(planCard(11, 'win-a', 'armed'))).toBe('plan-card:win-a')
    expect(viewKey(planCard(40, 'win-a', 'due'))).toBe(viewKey(planCard(11, 'win-a', 'armed')))
  })

  it('同一窗口的三次状态变化 ⇒ 仓库里只有一张卡，且是最后那一次', () => {
    const store = createStore()
    store.apply(planCard(11, 'win-a', 'armed'))
    store.apply(planCard(40, 'win-a', 'due'))
    store.apply(planCard(71, 'win-a', 'cancelled'))

    const cards = store.state().frames.filter((frame) => frame.kind === 'plan-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ state: 'cancelled', seq: 71, windowId: 'win-a' })
  })

  it('不同窗口互不替换（两个计划各自一张卡）', () => {
    const store = createStore()
    store.apply(planCard(11, 'win-a', 'armed'))
    store.apply(planCard(12, 'win-b', 'armed'))

    const cards = store.state().frames.filter((frame) => frame.kind === 'plan-card')
    expect(cards.map((frame) => frame.windowId)).toEqual(['win-a', 'win-b'])
  })

  it('快照重放：撤销后的窗口不会因为半新半旧而复活（I18 同口径）', () => {
    const store = createStore()
    store.apply(planCard(11, 'win-a', 'armed'))
    store.apply({
      kind: 'snapshot',
      seq: 200,
      at: 1_700_000_002_000,
      frames: [planCard(11, 'win-a', 'armed'), planCard(71, 'win-a', 'cancelled')],
    })

    const cards = store.state().frames.filter((frame) => frame.kind === 'plan-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].state).toBe('cancelled')
  })
})
