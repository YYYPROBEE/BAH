/**
 * 快捷短语 · 溢出提示（P2-1）。
 *
 * 滚动条被 `scrollbar-width: none` 藏掉后，屏外有没有内容只能靠一条渐隐提示判断。
 * 三个不变量：超宽才挂类、resize 后按新宽度重算、dispose 必须解绑同一个处理器。
 * jsdom 没有布局，`scrollWidth` / `clientWidth` 由用例显式注入。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQuickPhrases } from './quick-phrases.js'

/** 注入用的假 window（jsdom 不派发真实 resize）。 */
function fakeWin() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener: vi.fn((type, handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    }),
    removeEventListener: vi.fn((type, handler) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== handler))
    }),
    emit(type) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler({ type })
    },
  }
}

/** 给元素注入 jsdom 没有的布局尺寸。 */
function setWidths(node, scrollWidth, clientWidth) {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(node, 'clientWidth', { configurable: true, value: clientWidth })
}

describe('快捷短语 · 溢出提示', () => {
  let host

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
  })

  afterEach(() => {
    host.remove()
  })

  function mount(win) {
    return createQuickPhrases(host, {
      phrases: { items: [{ text: '甲' }] },
      onPick: () => undefined,
      win,
    })
  }

  it('内容超宽 ⇒ 挂 m-chips--overflow；不超宽 ⇒ 不挂（最后一颗不被无故淡掉）', () => {
    const view = mount(fakeWin())

    setWidths(view.node, 320, 100)
    view.syncOverflow()
    expect(view.node.classList.contains('m-chips--overflow')).toBe(true)

    setWidths(view.node, 100, 100)
    view.syncOverflow()
    expect(view.node.classList.contains('m-chips--overflow')).toBe(false)
  })

  it('1px 舍入误差不算溢出', () => {
    const view = mount(fakeWin())

    setWidths(view.node, 101, 100)
    view.syncOverflow()

    expect(view.node.classList.contains('m-chips--overflow')).toBe(false)
  })

  it('resize（横竖屏 / 键盘弹起）按新宽度重算，无需重建 chip', () => {
    const win = fakeWin()
    const view = mount(win)
    const before = view.node.querySelector('[data-role="chip"]')

    setWidths(view.node, 320, 100)
    win.emit('resize')
    expect(view.node.classList.contains('m-chips--overflow')).toBe(true)

    setWidths(view.node, 100, 100)
    win.emit('resize')
    expect(view.node.classList.contains('m-chips--overflow')).toBe(false)
    expect(view.node.querySelector('[data-role="chip"]')).toBe(before)
  })

  it('dispose 解绑同一个 resize 处理器并移除整行', () => {
    const win = fakeWin()
    const view = mount(win)
    const handler = win.listeners.get('resize')[0]

    view.dispose()

    expect(win.removeEventListener).toHaveBeenCalledWith('resize', handler)
    expect(host.querySelector('[data-role="quick-phrases"]')).toBeNull()
  })

  it('未注入 win 时回落到 globalThis.window（生产路径），dispose 同样解绑', () => {
    const add = vi.spyOn(globalThis.window, 'addEventListener')
    const remove = vi.spyOn(globalThis.window, 'removeEventListener')
    try {
      const view = mount(undefined)

      expect(add).toHaveBeenCalledWith('resize', view.syncOverflow)
      view.dispose()
      expect(remove).toHaveBeenCalledWith('resize', view.syncOverflow)
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })
})
