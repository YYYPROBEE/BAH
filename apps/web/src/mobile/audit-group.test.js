/**
 * 过程记录模块用例。
 *
 * 钉两件事：收起时必须先看见分类次数；展开/收起是本地状态，不能被后续审计帧重置。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuditGroup } from './audit-group.js'

function audit(overrides = {}) {
  return {
    kind: 'audit',
    seq: 1,
    at: 1_700_000_000_000,
    timeText: '08:00:00',
    category: 'safety',
    label: '安全防护',
    summary: 'sentry/trace · 命中',
    ...overrides,
  }
}

function frames() {
  return [
    audit({ seq: 1, category: 'safety' }),
    audit({ seq: 2, category: 'safety' }),
    audit({ seq: 3, category: 'tool', label: '工具完成', summary: 'intent_resolve' }),
    audit({ seq: 4, category: 'approval', label: '审批请求', summary: '请求执行 transfer_create' }),
  ]
}

describe('过程记录模块', () => {
  let host
  let group

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    group = createAuditGroup(host)
  })

  afterEach(() => {
    group.dispose()
    host.remove()
  })

  it('收起时只给分类次数，不铺明细', () => {
    group.update(frames())
    const node = host.querySelector('.audit-group')
    expect(node.hidden).toBe(false)
    expect(node.dataset.state).toBe('collapsed')
    expect(host.querySelector('[data-role="audit-toggle"]').textContent).toBe('展开')
    expect(host.querySelector('[data-role="audit-toggle"]').getAttribute('aria-expanded')).toBe('false')
    expect([...host.querySelectorAll('.audit__count')].map((item) => item.textContent)).toEqual([
      '安全防护2',
      '工具调用1',
      '审批1',
    ])
    expect(host.querySelectorAll('.audit__item').length).toBe(0)
  })

  it('点展开才铺明细，再点收起', () => {
    group.update(frames())
    const toggle = host.querySelector('[data-role="audit-toggle"]')
    toggle.click()
    expect(host.querySelector('.audit-group').dataset.state).toBe('expanded')
    expect(toggle.textContent).toBe('收起')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelectorAll('.audit__item').length).toBe(4)

    toggle.click()
    expect(host.querySelector('.audit-group').dataset.state).toBe('collapsed')
    expect(host.querySelectorAll('.audit__item').length).toBe(0)
  })

  it('后续审计帧更新不重置已展开状态', () => {
    group.update(frames())
    host.querySelector('[data-role="audit-toggle"]').click()

    group.update([...frames(), audit({ seq: 5, category: 'tool', label: '工具完成', summary: 'transfer_preview' })])

    expect(host.querySelector('.audit-group').dataset.state).toBe('expanded')
    expect(host.querySelectorAll('.audit__item').length).toBe(5)
    expect([...host.querySelectorAll('.audit__count')].map((item) => item.textContent)).toContain('工具调用2')
  })

  it('没有审计帧时整个模块隐藏', () => {
    group.update(frames())
    group.update([])
    expect(host.querySelector('.audit-group').hidden).toBe(true)
  })
})
