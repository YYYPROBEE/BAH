/**
 * 移动端计划卡（G7）：四块信息的可见性、未知值回退、只读与视觉口径。
 *
 * 与桌面姊妹用例同源：状态只认帧，不在视图层推导；状态用 `.ds-tag`，
 * 不用左侧竖条。日期展示走 UTC+8 固定换算，不依赖运行环境时区。
 */

import { describe, expect, it } from 'vitest'

import { renderPlanCard } from './plan-card.js'

/** 2026-10-24 10:00 +08:00 */
const DUE_AT = Date.UTC(2026, 9, 24, 2, 0)

/** 造一条计划卡帧。 */
function card(overrides = {}) {
  return {
    kind: 'plan-card',
    seq: 1,
    at: Date.UTC(2026, 9, 23, 2, 0),
    windowId: 'w-1',
    planId: 'plan-1',
    title: '生日采购',
    tier: 'standard',
    budgetText: '¥800.00',
    dueAt: DUE_AT,
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

describe('renderPlanCard（移动端）', () => {
  it('四块信息齐：授权档/预算、到期（判定时钟）、实例与节点数、条件快照', () => {
    const node = renderPlanCard(card())
    expect(node.getAttribute('aria-label')).toBe('计划卡：生日采购')
    expect(node.dataset.role).toBe('plan-card')
    expect(node.dataset.windowId).toBe('w-1')
    expect(node.dataset.state).toBe('armed')
    expect(node.textContent).toContain('标准档 · 预算 ¥800.00')
    expect(node.textContent).toContain('到期 2026-10-24 10:00（判定时钟）')
    expect(node.textContent).toContain('once:1761300000000 · 3 个节点')
    expect(node.textContent).toContain('balance-at-least')
    expect(node.textContent).toContain('>= 100000')
    expect(node.textContent).toContain('待复验')
    expect(node.textContent).toContain('成立')
  })

  it('状态用 ds-tag 表达（不用左侧竖条）', () => {
    const node = renderPlanCard(card({ state: 'failed' }))
    expect(node.querySelector('.ds-tag--danger')?.textContent).toBe('未达成')
    expect(node.getAttribute('style')).toBeNull()
    expect(node.className).not.toContain('border-left')
    expect(node.querySelector('[style*="border-left"]')).toBeNull()
  })

  it('未知状态 / 未知授权档 / 未知条件状态都回退到安全默认，不编造', () => {
    const node = renderPlanCard(
      card({
        state: 'paused',
        tier: 'vip',
        conditions: [{ kind: 'custom', expected: 'x', state: 'pending' }],
      }),
    )
    expect(node.dataset.state).toBe('paused')
    expect(node.textContent).toContain('已授权')
    expect(node.textContent).toContain('vip档')
    expect(node.textContent).toContain('待复验')
  })

  it('conditions 不是数组时按空列表渲染，不抛', () => {
    const node = renderPlanCard(card({ conditions: 'oops' }))
    expect(node.querySelectorAll('.m-plan-card__condition')).toHaveLength(0)
  })

  it('补偿记录渲染「已冲正」行（ADR-0013）', () => {
    const node = renderPlanCard(
      card({ compensation: { kind: 'reversed', txnId: 'txn-1', amountCents: 15_900 } }),
    )
    expect(node.querySelector('.m-plan-card__compensation')?.textContent).toContain('已冲正 ¥159.00')
  })

  it('有 lastVerdict 时把已知码翻译成人话，未知码原样展示', () => {
    const known = renderPlanCard(
      card({ state: 'failed', lastVerdict: { code: 'condition-failed', at: 1 } }),
    )
    expect(known.querySelector('.m-plan-card__verdict')?.textContent).toBe('最近判决：条件已变化')

    const unknown = renderPlanCard(
      card({ state: 'failed', lastVerdict: { code: 'mystery', at: 1 } }),
    )
    expect(unknown.textContent).toContain('最近判决：mystery')
  })

  it('无 lastVerdict 时不渲染判决行', () => {
    const node = renderPlanCard(card())
    expect(node.querySelector('.m-plan-card__verdict')).toBeNull()
  })

  it('过期 / 待重新确认两个状态（提示词 4-2，与桌面同口径）', () => {
    const expired = renderPlanCard(
      card({ state: 'expired', lastVerdict: { code: 'window-expired', at: 1 } }),
    )
    expect(expired.dataset.state).toBe('expired')
    expect(expired.querySelector('.ds-tag')?.textContent).toBe('已过期')

    const reconfirm = renderPlanCard(
      card({ state: 'needs-reconfirm', lastVerdict: { code: 'details-changed', at: 1 } }),
    )
    expect(reconfirm.querySelector('.ds-tag--warning')?.textContent).toBe('待重新确认')
    expect(reconfirm.textContent).toContain('最近判决：明细与批准时不一致')
  })

  it('所有字段走文本节点：标题里的标签不会变成 DOM', () => {
    const node = renderPlanCard(
      card({ title: '<img src=x onerror="alert(1)">', conditions: [] }),
    )
    expect(node.querySelector('img')).toBeNull()
    expect(node.textContent).toContain('<img src=x onerror="alert(1)">')
  })
})
