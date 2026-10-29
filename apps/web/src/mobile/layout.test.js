/**
 * 布局与安全区用例（TC-MOB-29）。
 *
 * 桩纪律：`win` 是注入的假 window（jsdom 没有 `visualViewport`，也不派发真实 resize）。
 * 生产路径 `createLayout(root)` 不传 `deps.win`，走真实 `globalThis.window`（A1 探针）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLayout } from './layout.js'

/** 假 window：只实现 layout.js 真正用到的那几项。 */
function fakeWin({ innerHeight = 800, viewportHeight = 800, hasViewport = true } = {}) {
  const winListeners = new Map()
  const viewportListeners = new Map()

  const emit = (map, type) => {
    for (const fn of map.get(type) ?? []) fn(new Event(type))
  }

  const visualViewport = hasViewport
    ? {
        height: viewportHeight,
        offsetTop: 0,
        addEventListener: (type, fn) => viewportListeners.set(type, [...(viewportListeners.get(type) ?? []), fn]),
        removeEventListener: (type, fn) =>
          viewportListeners.set(type, (viewportListeners.get(type) ?? []).filter((item) => item !== fn)),
      }
    : undefined

  return {
    innerHeight,
    visualViewport,
    addEventListener: (type, fn) => winListeners.set(type, [...(winListeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) =>
      winListeners.set(type, (winListeners.get(type) ?? []).filter((item) => item !== fn)),
    emitResize: () => {
      emit(viewportListeners, 'resize')
      emit(winListeners, 'resize')
    },
    emitViewportScroll: () => emit(viewportListeners, 'scroll'),
    listenerCount: () =>
      [...winListeners.values()].reduce((sum, list) => sum + list.length, 0) +
      [...viewportListeners.values()].reduce((sum, list) => sum + list.length, 0),
    setViewportHeight(next) {
      if (visualViewport !== undefined) visualViewport.height = next
    },
  }
}

describe('移动布局', () => {
  let root
  let win

  beforeEach(() => {
    root = document.createElement('div')
    root.className = 'm-shell'
    document.body.append(root)
    win = fakeWin()
  })

  afterEach(() => {
    root.remove()
  })

  it('三区骨架 + 遮罩挂载点，且顺序是 header → feed → dock → overlay', () => {
    const layout = createLayout(root, { win })
    const children = [...root.children].map((node) => node.className)

    expect(children).toEqual(['m-header', 'm-feed', 'm-dock', 'm-overlay-host'])
    expect(layout.regions.feed.id).toBe('m-feed')
    expect(layout.regions.overlayHost.id).toBe('m-overlay')
    expect(layout.regions.feed.getAttribute('aria-label')).toBe('对话与执行')
    layout.dispose()
  })

  it('TC-MOB-29 resize（横竖屏）⇒ 节点引用相等，一个都不重建', () => {
    const layout = createLayout(root, { win })
    const before = { ...layout.regions }
    const feedChildren = [document.createElement('p'), document.createElement('p')]
    for (const child of feedChildren) layout.regions.feed.append(child)

    win.emitResize()
    win.emitResize()

    expect(layout.regions.header).toBe(before.header)
    expect(layout.regions.feed).toBe(before.feed)
    expect(layout.regions.dock).toBe(before.dock)
    expect(layout.regions.overlayHost).toBe(before.overlayHost)
    expect([...layout.regions.feed.children]).toEqual(feedChildren)
    layout.dispose()
  })

  it('软键盘顶起 ⇒ dock 走 CSSOM transform（不是 style 属性，CSP 安全）', () => {
    const layout = createLayout(root, { win })
    win.setViewportHeight(500)

    win.emitResize()

    expect(layout.keyboardInset()).toBe(300)
    expect(layout.regions.dock.style.transform).toBe('translateY(-300px)')
    expect(layout.regions.dock.getAttribute('style')).toContain('transform')
    layout.dispose()
  })

  it('键盘收起 ⇒ transform 清空（不留一个悬在半空的输入区）', () => {
    const layout = createLayout(root, { win })
    win.setViewportHeight(500)
    win.emitResize()
    expect(layout.regions.dock.style.transform).toBe('translateY(-300px)')

    win.setViewportHeight(800)
    win.emitResize()

    expect(layout.keyboardInset()).toBe(0)
    expect(layout.regions.dock.style.transform).toBe('')
    layout.dispose()
  })

  it('visualViewport 的 scroll 也触发重算（iOS 上键盘弹起先 scroll 后 resize）', () => {
    const layout = createLayout(root, { win })
    win.setViewportHeight(600)

    win.emitViewportScroll()

    expect(layout.keyboardInset()).toBe(200)
    layout.dispose()
  })

  it('无 visualViewport（旧安卓 WebView）⇒ 降级为不避让，不猜键盘高度', () => {
    const legacy = fakeWin({ hasViewport: false })
    const layout = createLayout(root, { win: legacy })

    legacy.emitResize()

    expect(layout.keyboardInset()).toBe(0)
    expect(layout.regions.dock.style.transform).toBe('')
    layout.dispose()
  })

  it('缺省走真实 window（生产路径不注入 win）', () => {
    const layout = createLayout(root)

    expect(layout.keyboardInset()).toBe(0)
    expect(root.children.length).toBe(4)
    layout.dispose()
  })

  it('onKeyboard 可订阅可退订', () => {
    const layout = createLayout(root, { win })
    const listener = vi.fn()
    const off = layout.onKeyboard(listener)

    win.setViewportHeight(700)
    win.emitResize()
    // 两个事件源各触发一次重算：visualViewport 与 window 都要听——
    // iOS 上键盘弹起只发其中一个，只听一个就会在另一种机型上"输入框被键盘吃掉"
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith({ inset: 100 })

    off()
    win.emitResize()
    expect(listener).toHaveBeenCalledTimes(2)
    layout.dispose()
  })

  it('连接状态与会话 ID 的文案落进 header（三态各有其类）', () => {
    const layout = createLayout(root, { win })

    expect(layout.statusNode.className).toBe('m-status m-status--connecting')
    layout.setStatus('online')
    expect(layout.statusNode.className).toBe('m-status m-status--online')
    expect(layout.statusNode.textContent).toContain('已连接')
    layout.setStatus('offline')
    expect(layout.statusNode.className).toBe('m-status m-status--offline')
    expect(layout.statusNode.textContent).toContain('已断开')
    layout.setStatus('nonsense')
    expect(layout.statusNode.className).toBe('m-status m-status--connecting')

    layout.setSession('s-42')
    expect(layout.sessionLabel.textContent).toBe('会话 s-42')
    layout.dispose()
  })

  it('dispose 摘掉全部监听（不留游离监听在假 window 上）', () => {
    const layout = createLayout(root, { win })
    layout.onKeyboard(() => {})
    expect(win.listenerCount()).toBeGreaterThan(0)

    layout.dispose()

    expect(win.listenerCount()).toBe(0)
  })
})
