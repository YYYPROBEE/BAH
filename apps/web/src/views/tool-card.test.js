/**
 * 工具卡片用例（T-WEB-002 三态 / T-WEB-005 金额降级）。
 *
 * 只断言"渲染出来的节点里有哪些可判定的事实"：状态属性、文案、降级标记、合规提示。
 */

import { describe, expect, it } from 'vitest'

import { renderTool } from './tool-card.js'

/** 造一条工具帧。 */
function tool(overrides = {}) {
  return {
    kind: 'tool',
    seq: 1,
    at: 1_700_000_000_000,
    callId: 'call-1',
    name: 'transfer_create',
    title: '转账',
    state: 'pending',
    tier: 'yellow',
    amountConfirmed: false,
    card: {
      kind: 'tool.transfer_create',
      template: 'transfer',
      title: '转账',
      fields: [{ label: '金额', value: '¥800.00', amount: true, mono: true }],
      tags: [],
    },
    ...overrides,
  }
}

describe('工具卡片 · 三态（T-WEB-002）', () => {
  it('待执行 / 完成 / 已拦截：状态属性 + 文案 + 色调都在', () => {
    const pending = renderTool(tool())
    expect(pending.dataset.state).toBe('pending')
    expect(pending.textContent).toContain('待执行')

    const done = renderTool(tool({ state: 'done', amountConfirmed: true }))
    expect(done.dataset.state).toBe('done')
    expect(done.textContent).toContain('已完成')

    const denied = renderTool(
      tool({ state: 'denied', reasonKind: 'denied', code: 'PRV-002', reason: '危险指令' }),
    )
    expect(denied.dataset.state).toBe('denied')
    expect(denied.textContent).toContain('已拦截')
    expect(denied.textContent).toContain('PRV-002')
  })

  it('执行失败与判决拦截的文案不同（不把内部错误说成"被拒"）', () => {
    const failed = renderTool(tool({ state: 'denied', reasonKind: 'failed', code: 'tool-failed' }))
    expect(failed.textContent).toContain('执行失败')
    expect(failed.textContent).not.toContain('已拦截')
  })

  it('权限级别随节点暴露（DAG 与卡片一致）', () => {
    expect(renderTool(tool()).dataset.tier).toBe('yellow')
    expect(renderTool(tool({ tier: 'red' })).textContent).toContain('红级')
  })
})

describe('工具卡片 · 金额降级（T-WEB-005）', () => {
  it('未确认 → 灰 + "待确认" + aria-label', () => {
    const node = renderTool(tool())
    const value = node.querySelector('.field__value')
    expect(value.className).toContain('field__value--unconfirmed')
    const tag = node.querySelector('.field__pending')
    expect(tag.textContent).toBe('待确认')
    expect(tag.getAttribute('aria-label')).toContain('金额待确认')
  })

  it('已确认 → 不加降级标记', () => {
    const node = renderTool(tool({ state: 'done', amountConfirmed: true }))
    expect(node.querySelector('.field__value--unconfirmed')).toBeNull()
    expect(node.querySelector('.field__pending')).toBeNull()
  })

  it('金额字段始终等宽（数字不抖动）', () => {
    const node = renderTool(tool({ amountConfirmed: true }))
    expect(node.querySelector('.field__value').className).toContain('field__value--mono')
  })
})

describe('工具卡片 · 合规与正文', () => {
  it('风险提示永不折叠，且带 disclaimerId', () => {
    const node = renderTool(
      tool({
        card: {
          kind: 'tool.wealth_list',
          template: 'wealth',
          title: '理财产品',
          fields: [],
          tags: [{ text: '理财非存款', tone: 'warning' }],
          disclaimer: { id: 'wealth.disclaimer.v1', text: '风险提示：理财非存款' },
        },
      }),
    )
    const alert = node.querySelector('.tool-card__disclaimer')
    expect(alert).not.toBeNull()
    expect(alert.textContent).toContain('wealth.disclaimer.v1')
    expect(alert.className).toContain('ds-alert--warning')
  })

  it('正文用 pre 保留换行（模型给的多行结果不被压平）', () => {
    const node = renderTool(
      tool({
        card: { kind: 'k', template: 'generic', title: '结果', fields: [], tags: [], body: '第一行\n第二行' },
      }),
    )
    const body = node.querySelector('.tool-card__body')
    expect(body.tagName).toBe('PRE')
    expect(body.textContent).toContain('\n')
  })
})
