/**
 * 快捷短语 chips 用例（TC-MOB-19）。
 *
 * chips 是 D10 的演示主入口：离线、确定性。这里钉两件事——
 * ① 点一颗就是**一条普通用户消息**（与 D6 同一路径，不绕过任何审批）；
 * ② 文案来自注入配置，视图层零硬编码（换一组配置，渲染结果随之变化）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_QUICK_PHRASES } from './shell.js'
import { createQuickPhrases } from './quick-phrases.js'

describe('快捷短语 chips', () => {
  let host
  let onPick

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    onPick = vi.fn()
  })

  afterEach(() => {
    host.remove()
  })

  function chips(items) {
    return createQuickPhrases(host, { phrases: { items }, onPick })
  }

  const buttons = () => [...host.querySelectorAll('[data-role="chip"]')]

  it('TC-MOB-19 点击即发一条消息，请求文本与 chip 文案逐字一致、恰一次', () => {
    chips([{ text: '转 500 给他', intent: '省略槽位' }])

    buttons()[0].dispatchEvent(new Event('click'))

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('转 500 给他')
  })

  it('TC-MOB-19 文案来自注入配置而非视图硬编码：换一组配置，渲染结果随之变化', () => {
    const first = chips([{ text: '甲', intent: 'x' }])
    expect(buttons().map((node) => node.textContent)).toEqual(['甲'])

    first.dispose()
    host.replaceChildren()
    chips([{ text: '乙', intent: 'y' }, { text: '丙', intent: 'z' }])
    expect(buttons().map((node) => node.textContent)).toEqual(['乙', '丙'])
  })

  it('TC-MOB-19 意图标签落进 data-intent（答辩现场可对上 03 单的四类意图）', () => {
    chips([{ text: '甲', intent: '模糊复现' }])

    expect(buttons()[0].dataset.intent).toBe('模糊复现')
  })

  it('空配置渲染零 chip，不报错', () => {
    chips([])
    expect(buttons().length).toBe(0)

    host.replaceChildren()
    chips(undefined)
    expect(buttons().length).toBe(0)
  })

  it('装饰图标 aria-hidden（语义由 chip 文本承担）', () => {
    chips([{ text: '甲', intent: 'x' }])

    expect(buttons()[0].querySelector('.icon--chat').getAttribute('aria-hidden')).toBe('true')
  })

  it('render() 可重入：重复调用不叠加 chip', () => {
    const view = chips([{ text: '甲', intent: 'x' }])
    view.render()
    view.render()

    expect(buttons().length).toBe(1)
  })

  it('默认文案四条对应 03 单四类意图，且不含真实账号/户名', () => {
    const items = DEFAULT_QUICK_PHRASES.items

    expect(items.length).toBe(4)
    expect(items.map((item) => item.intent)).toEqual(['模糊复现', '省略槽位', '隐含意图', '歧义消解'])
    for (const item of items) {
      expect(item.text).not.toMatch(/\d{6,}/)
      expect(item.text).not.toContain('王建国')
    }
  })

  it('dispose 移除整行', () => {
    const view = chips([{ text: '甲', intent: 'x' }])
    view.dispose()

    expect(host.querySelector('[data-role="quick-phrases"]')).toBeNull()
  })
})
