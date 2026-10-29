/**
 * DAG 视图用例（T-WEB-006）。
 *
 * 验收口径来自施工单 13 §2.1：节点带权限级别、失败节点下游可见且标记阻断。
 */

import { describe, expect, it } from 'vitest'

import { renderDag } from './dag.js'

/** 造一条 DAG 帧：step1 → A（成功）→ B（被拦截）→ step2 → C（未执行）。 */
function dagFrame() {
  return {
    kind: 'dag',
    seq: 9,
    at: 1_700_000_000_000,
    turn: 1,
    nodes: [
      { id: 'step:1:1', label: '步骤 1', kind: 'step', step: 1, tier: 'unknown', state: 'ok' },
      { id: 'call:A', label: 'transfer_preview', kind: 'call', step: 1, tier: 'green', state: 'ok' },
      { id: 'call:B', label: 'transfer_create', kind: 'call', step: 1, tier: 'yellow', state: 'denied' },
      { id: 'step:1:2', label: '步骤 2', kind: 'step', step: 2, tier: 'unknown', state: 'ok' },
      { id: 'call:C', label: 'wealth_purchase', kind: 'call', step: 2, tier: 'red', state: 'blocked' },
    ],
    edges: [
      { from: 'step:1:1', to: 'call:A' },
      { from: 'call:A', to: 'call:B' },
      { from: 'call:B', to: 'step:1:2' },
      { from: 'step:1:2', to: 'call:C' },
    ],
    summary: '第 1 轮 · 3 个调用 · 1 个被拦截 · 1 个下游已阻断',
  }
}

describe('DAG · 阻断传播（T-WEB-006）', () => {
  it('被拦截节点与下游阻断节点都带状态标记', () => {
    const svg = renderDag(dagFrame())
    const blocked = svg.querySelector('[data-node-id="call:C"]')
    const denied = svg.querySelector('[data-node-id="call:B"]')

    expect(blocked.getAttribute('data-blocked')).toBe('true')
    expect(blocked.getAttribute('data-state')).toBe('blocked')
    expect(denied.getAttribute('data-state')).toBe('denied')
  })

  it('阻断节点使用虚线描边 + 文字降透明（不只靠颜色）', () => {
    const svg = renderDag(dagFrame())
    const rect = svg.querySelector('[data-node-id="call:C"] rect')
    expect(rect.getAttribute('stroke-dasharray')).toBe('4 3')
  })

  it('节点携带权限级别（绿/黄/红 三档都在）', () => {
    const svg = renderDag(dagFrame())
    const badges = [...svg.querySelectorAll('[data-node-id^="call:"]')].map((group) =>
      group.querySelector('text:last-of-type').textContent,
    )
    expect(badges).toEqual(['绿', '黄', '红'])
  })
})

describe('DAG · 可访问性', () => {
  it('图有 role=img 与文字摘要；每个节点有 title', () => {
    const svg = renderDag(dagFrame())
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toContain('下游已阻断')

    const titles = [...svg.querySelectorAll('title')].map((node) => node.textContent)
    expect(titles).toHaveLength(5)
    expect(titles.join('')).toContain('已阻断')
  })

  it('长标签截断，不撑破节点', () => {
    const svg = renderDag({
      ...dagFrame(),
      nodes: [{ id: 'call:X', label: 'a'.repeat(40), kind: 'call', step: 1, tier: 'green', state: 'ok' }],
      edges: [],
    })
    const text = svg.querySelector('[data-node-id="call:X"] text')
    expect(text.textContent.length).toBeLessThanOrEqual(12)
    expect(text.textContent).toContain('…')
  })

  it('没有节点也不崩（空图有 viewBox 与摘要）', () => {
    const svg = renderDag({ kind: 'dag', seq: 1, at: 1, turn: 1, nodes: [], edges: [], summary: '空' })
    expect(svg.getAttribute('viewBox')).toContain('0 0')
  })

  it('字号走 CSS 类（令牌），不再硬编码 font-size 属性', () => {
    const svg = renderDag(dagFrame())
    const label = svg.querySelector('[data-node-id="call:A"] .dag__label')
    const badge = svg.querySelector('[data-node-id="call:A"] .dag__badge')
    expect(label).not.toBeNull()
    expect(label.getAttribute('font-size')).toBeNull()
    expect(badge.getAttribute('font-size')).toBeNull()
  })
})
