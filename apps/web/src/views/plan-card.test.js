/**
 * 计划卡视图用例（G7）：四块信息的可见性 + 状态只用徽标（不用左侧竖条）。
 *
 * 只断言节点里可判定的事实：状态 dataset、四块信息文案、失守条件的实际值、判决文案。
 */

import { describe, expect, it } from 'vitest'

import { renderPlanCard } from './plan-card.js'

/** 造一条计划卡帧。 */
function card(overrides = {}) {
  return {
    kind: 'plan-card',
    seq: 1,
    at: 1_761_200_000_000,
    windowId: 'w-1',
    planId: 'plan-1',
    title: '生日采购',
    tier: 'standard',
    budgetText: '¥800.00',
    dueAt: 1_761_300_000_000,
    occurrence: 'once:1761300000000',
    state: 'armed',
    conditions: [
      { kind: 'balance-at-least', expected: '>= 100000', state: 'unknown' },
      { kind: 'fact-unchanged', expected: 'f-1@2', state: 'ok' },
    ],
    nodeCount: 3,
    digest: '0123456789abcdef0123',
    ...overrides,
  }
}

describe('renderPlanCard', () => {
  it('四块信息齐：授权档/预算、到期（标注判定时钟）、实例与节点数、条件快照', () => {
    const node = renderPlanCard(card())
    const text = node.textContent
    expect(text).toContain('标准 · 预算 ¥800.00')
    expect(text).toContain('到期（判定时钟）')
    expect(text).toContain('once:1761300000000 · 3 个节点')
    expect(text).toContain('条件快照')
    expect(text).toContain('balance-at-least')
    expect(text).toContain('待复验')
  })

  it('状态用 ds-tag 表达（不用左侧竖条）', () => {
    const node = renderPlanCard(card({ state: 'failed' }))
    expect(node.dataset.state).toBe('failed')
    expect(node.querySelector('.ds-tag--danger')?.textContent).toBe('未达成')
    // 视觉口径：卡片自身不带 border-left 的类名或内联样式
    expect(node.getAttribute('style')).toBeNull()
    expect(node.className).not.toContain('border-left')
  })

  it('失守条件显示实际值；无 lastVerdict 时不渲染判决行', () => {
    const failed = renderPlanCard(
      card({
        state: 'failed',
        conditions: [
          { kind: 'balance-at-least', expected: '>= 100000', state: 'failed', actual: '60000' },
        ],
      }),
    )
    expect(failed.textContent).toContain('实际 60000')
    expect(failed.textContent).toContain('失守')
    expect(failed.querySelector('.plan-card__verdict')).toBeNull()
  })

  it('有 lastVerdict 时把码翻译成人话', () => {
    const node = renderPlanCard(
      card({ state: 'failed', lastVerdict: { code: 'condition-failed', at: 1 } }),
    )
    expect(node.querySelector('.plan-card__verdict')?.textContent).toContain('条件已变化')
  })

  it('无条件时给一句说明（不渲染空列表）', () => {
    const node = renderPlanCard(card({ conditions: [] }))
    expect(node.textContent).toContain('本计划没有附加条件')
  })
})
