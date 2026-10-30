/**
 * 已发生操作清单用例（`effects` 帧 → 桌面壳卡片）。
 *
 * 核心约束是**只读**：这张卡回答"钱动了没有"，不能出现任何看起来能撤销的入口
 * （撤销/冲正属 saga 补偿面）。金额与工具名原样展示，前端不二次加工。
 */

import { describe, expect, it } from 'vitest'

import { renderEffects } from './effects.js'

/** 造一条影响面帧。 */
function effects(overrides = {}) {
  return {
    kind: 'effects',
    seq: 232,
    at: 1_793_332_970_000,
    turn: 6,
    items: [
      {
        callId: 'call-create',
        name: 'transfer_create',
        title: '转账',
        amountText: '¥30.00',
        durationMs: 4049,
        tone: 'success',
      },
    ],
    ticketId: 'ticket:8c17748d',
    ...overrides,
  }
}

describe('已发生操作清单', () => {
  it('列出标题 / 金额 / 工具名 / 耗时', () => {
    const node = renderEffects(effects())
    expect(node.dataset.role).toBe('effects')
    expect(node.dataset.turn).toBe('6')
    const item = node.querySelector('[data-role="effect-item"]')
    expect(item.dataset.callId).toBe('call-create')
    expect(item.textContent).toContain('转账')
    expect(item.textContent).toContain('¥30.00')
    expect(item.textContent).toContain('transfer_create')
    expect(item.textContent).toContain('4049ms')
  })

  it('只读：零按钮、零链接', () => {
    const node = renderEffects(effects())
    expect(node.querySelectorAll('button, a')).toHaveLength(0)
  })

  it('金额/耗时缺省时不渲染空节点', () => {
    const node = renderEffects(
      effects({ items: [{ callId: 'c1', name: 'account_balance', title: '查询余额', tone: 'success' }] }),
    )
    const item = node.querySelector('[data-role="effect-item"]')
    expect(item.querySelector('.effects__amount')).toBeNull()
    expect(item.querySelector('.effects__meta')).toBeNull()
  })

  it('多条操作逐条列出（不合并成一段文字）', () => {
    const node = renderEffects(
      effects({
        items: [
          { callId: 'c1', name: 'transfer_create', title: '转账', amountText: '¥30.00', tone: 'success' },
          { callId: 'c2', name: 'card_lock', title: '锁卡', tone: 'success' },
        ],
      }),
    )
    expect(node.querySelectorAll('[data-role="effect-item"]')).toHaveLength(2)
  })

  it('清单文本只作文本节点（HTML 不执行）', () => {
    const evil = '<img src=x onerror="window.__pwned=1">'
    const node = renderEffects(
      effects({ items: [{ callId: evil, name: evil, title: evil, amountText: evil, tone: 'success' }] }),
    )
    expect(node.querySelector('img')).toBeNull()
    expect(node.textContent).toContain(evil)
  })
})
