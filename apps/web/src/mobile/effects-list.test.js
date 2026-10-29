/**
 * 已发生操作清单用例（TC-MOB-27）。
 *
 * 只读性是这个组件的**全部价值**：中断之后回答"钱动了没有"。
 * 所以"零 button / 零 a"不是形式主义——一个看起来能点的"撤销"会让人觉得可以撤回，
 * 而撤销属于 saga 补偿面，呈现层给不了。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createEffectsList } from './effects-list.js'

function effectsFrame(turn, items, overrides = {}) {
  return { kind: 'effects', seq: 10 + turn, at: 1000 + turn, turn, items, ...overrides }
}

const ITEM_A = { callId: 'c-1', name: 'transfer_create', title: '转账到王建国', amountText: '¥ 800.00', durationMs: 120, tone: 'success' }
const ITEM_B = { callId: 'c-2', name: 'wealth_purchase', title: '申购稳盈 90 天', amountText: '¥ 1,000.00', tone: 'default' }

describe('已发生操作清单', () => {
  let host
  let list

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    list = createEffectsList(host)
  })

  afterEach(() => {
    list.dispose()
    host.remove()
  })

  const items = () => [...host.querySelectorAll('[data-role="effect-item"]')]
  const groups = () => [...host.querySelectorAll('[data-role="effects-group"]')]

  it('TC-MOB-27 条目追加，文本与帧字段逐字相等（前端不加工金额）', () => {
    list.append(effectsFrame(1, [ITEM_A]))

    expect(items().length).toBe(1)
    expect(items()[0].querySelector('.m-effects__name').textContent).toBe('转账到王建国')
    expect(items()[0].querySelector('.m-effects__amount').textContent).toBe('¥ 800.00')
    expect(items()[0].querySelector('.ds-tag').textContent).toBe('transfer_create')
    expect(items()[0].querySelector('.m-effects__meta').textContent).toBe('120ms')
    expect(items()[0].dataset.callId).toBe('c-1')
  })

  it('TC-MOB-27 零 button / 零 a：只读性由结构保证', () => {
    list.append(effectsFrame(1, [ITEM_A, ITEM_B]))

    expect(host.querySelectorAll('button').length).toBe(0)
    expect(host.querySelectorAll('a').length).toBe(0)
    expect(host.querySelectorAll('input, select, textarea').length).toBe(0)
  })

  it('TC-MOB-27 多轮倒序分组：最新一轮在最上面', () => {
    list.append(effectsFrame(1, [ITEM_A]))
    list.append(effectsFrame(2, [ITEM_B]))
    list.append(effectsFrame(3, [ITEM_A]))

    expect(groups().map((group) => group.dataset.turn)).toEqual(['3', '2', '1'])
    expect(groups().map((group) => group.querySelector('.m-effects__group-label').textContent)).toEqual([
      '第 3 轮',
      '第 2 轮',
      '第 1 轮',
    ])
    expect(list.turns).toEqual([3, 2, 1])
  })

  it('同轮新帧替换旧帧（帧键 effects:<turn> 的替换语义）', () => {
    list.append(effectsFrame(1, [ITEM_A]))
    list.append(effectsFrame(1, [ITEM_A, ITEM_B]))

    expect(groups().length).toBe(1)
    expect(items().length).toBe(2)
  })

  it('可选字段缺席不渲染空壳（amountText/durationMs 为 undefined）', () => {
    list.append(effectsFrame(1, [{ callId: 'c-3', name: 'card_report_lost', title: '挂失银行卡', tone: 'warning' }]))
    const item = items()[0]

    expect(item.querySelector('.m-effects__amount')).toBeNull()
    expect(item.querySelector('.m-effects__meta')).toBeNull()
    expect(item.querySelector('.m-effects__name').textContent).toBe('挂失银行卡')
  })

  it('没有帧时整块收起（不留一个"已发生的操作：空"的吓人标题）', () => {
    expect(list.node.hidden).toBe(true)

    list.append(effectsFrame(1, []))
    expect(list.node.hidden).toBe(false)
    expect(items().length).toBe(0)
  })

  it('dispose 移除节点', () => {
    list.append(effectsFrame(1, [ITEM_A]))
    list.dispose()

    expect(host.querySelector('[data-role="effects"]')).toBeNull()
  })
})
