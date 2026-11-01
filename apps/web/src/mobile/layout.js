/**
 * 窄屏三区骨架与安全区。
 *
 * 只做三件事：搭骨架、把软键盘的顶起量翻译成 dock 的位移、把 resize 转成通知。
 * **不做**任何业务推导，也**不缓存**宽高——横竖屏切换时单列弹性 CSS 自己承担重排，
 * JS 一旦缓存了尺寸，旋转后就会出现"抽屉轨道宽还是竖屏那个数"这类假 bug（§3.9）。
 *
 * 安全区（`env(safe-area-inset-*)`）全在 CSS 里，本文件一行都不碰：
 * 布局响应视口是 JS 的活，布局响应刘海是 CSS 的活，混在一起就没人说得清谁赢了。
 */

import { BRAND } from '../brand.js'
import { el } from '../dom.js'

/**
 * 造布局。
 *
 * @param {HTMLElement} root m.html 的 `#app.m-shell`
 * @param {{ win?: Window }} [deps] `win` 仅测试注入（jsdom 无 visualViewport）
 * @returns {{
 *   regions: { header: HTMLElement, feed: HTMLElement, dock: HTMLElement, overlayHost: HTMLElement },
 *   sessionLabel: HTMLElement,
 *   statusNode: HTMLElement,
 *   setStatus: (status: 'connecting'|'online'|'offline') => void,
 *   setSession: (sessionId: string) => void,
 *   onKeyboard: (fn: (info: { inset: number }) => void) => () => void,
 *   keyboardInset: () => number,
 *   dispose: () => void,
 * }}
 */
export function createLayout(root, deps = {}) {
  const win = deps.win ?? globalThis.window

  const statusText = el('span', { class: 'm-status__text', text: '连接中' })
  const statusNode = el('span', { class: 'm-status m-status--connecting' }, [
    el('span', { class: 'm-status__dot', 'aria-hidden': 'true' }),
    statusText,
  ])
  const sessionLabel = el('span', { class: 'm-header__session', text: '会话 —' })

  const header = el('header', { class: 'm-header' }, [
    el('span', { class: 'm-header__title', text: BRAND.name }),
    el('div', { class: 'm-header__meta' }, [sessionLabel, statusNode]),
  ])
  const feed = el('main', { class: 'm-feed', id: 'm-feed', 'aria-label': '对话与执行' })
  const dock = el('div', { class: 'm-dock' })
  // `display: contents`：挂载点自己不产生盒子，抽屉的 position:fixed 直接对视口定位
  const overlayHost = el('div', { class: 'm-overlay-host', id: 'm-overlay' })

  root.append(header, feed, dock, overlayHost)

  /** 键盘顶起的订阅者（返回退订函数）。 */
  const keyboardListeners = new Set()
  let inset = 0

  /**
   * 软键盘占掉的像素 = 布局视口高 − 可视视口高。
   *
   * 无 `visualViewport`（旧安卓 WebView）时恒为 0 ⇒ **降级为不避让**，
   * 输入框靠浏览器原生滚动保持可。这比"猜一个键盘高度"诚实。
   */
  function measure() {
    const viewport = win?.visualViewport
    if (viewport === undefined || viewport === null) return 0
    const layoutHeight = typeof win.innerHeight === 'number' ? win.innerHeight : 0
    return Math.max(0, Math.round(layoutHeight - Number(viewport.height)))
  }

  function applyViewport() {
    inset = measure()
    // CSSOM 写法（不是 style 属性）：CSP `style-src 'self'` 不管 CSSOM（§3.1 自查 / C5 探针）
    dock.style.transform = inset > 0 ? `translateY(-${String(inset)}px)` : ''
    for (const fn of keyboardListeners) fn({ inset })
  }

  const viewport = win?.visualViewport
  const onResize = () => applyViewport()
  viewport?.addEventListener('resize', onResize)
  viewport?.addEventListener('scroll', onResize)
  // 横竖屏：只听 resize（orientationchange 已废弃）；不重建任何节点
  win?.addEventListener('resize', onResize)

  const STATUS = {
    connecting: { label: '连接中', cls: 'm-status m-status--connecting' },
    online: { label: '已连接', cls: 'm-status m-status--online' },
    offline: { label: '已断开（重试中）', cls: 'm-status m-status--offline' },
  }

  return {
    regions: { header, feed, dock, overlayHost },
    sessionLabel,
    statusNode,
    setStatus(status) {
      const entry = STATUS[status] ?? STATUS.connecting
      statusNode.className = entry.cls
      statusText.textContent = entry.label
    },
    setSession(sessionId) {
      sessionLabel.textContent = `会话 ${sessionId}`
    },
    onKeyboard(fn) {
      keyboardListeners.add(fn)
      return () => keyboardListeners.delete(fn)
    },
    keyboardInset: () => inset,
    dispose() {
      viewport?.removeEventListener('resize', onResize)
      viewport?.removeEventListener('scroll', onResize)
      win?.removeEventListener('resize', onResize)
      keyboardListeners.clear()
    },
  }
}
