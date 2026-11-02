/**
 * 移动壳的历史对话面板（2026-11-02）。
 *
 * 复用 `views/history.js` 的纯渲染件——列表与只读回放的口径必须与桌面壳逐字一致，
 * 否则"桌面看到 42 条、手机看到 41 条"这类分叉迟早出现。本文件只负责三件事：
 * 全屏容器的开合、`close` 的焦点归还、以及把两次请求的失败收敛成一句可读的话。
 *
 * 为什么不做"底部抽屉"：历史是**逐条阅读**的列表（每条要显示标题 + 时间 + 轮数），
 * 底部抽屉最多露出半屏，用户要滑两次才能看完 20 条。审批抽屉之所以是抽屉，
 * 是因为它在打断对话流时只要求一次决策；历史不打断任何东西，全屏更合适。
 */

import { el, icon } from '../dom.js'
import { renderHistoryPanel, renderReadonlyView } from '../views/history.js'

/** 关闭按钮的无障碍名（测试与读屏共用一份文案）。 */
export const HISTORY_CLOSE_LABEL = '关闭历史'

/**
 * @param {HTMLElement} host 遮罩挂载点（`layout.regions.overlayHost`）
 * @param {{
 *   loadList: () => Promise<{ok: boolean, data?: unknown, reason?: string}>,
 *   loadSession: (id: string) => Promise<{ok: boolean, data?: unknown, reason?: string}>,
 *   renderFrame: (frame: unknown) => HTMLElement,
 * }} deps
 */
export function createHistorySheet(host, deps) {
  let node = null
  let restoreFocus = null

  function onKey(event) {
    if (node === null) return
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  /** 关闭（可重复调用；不依赖"当前在第几层"，一层就够）。 */
  function close() {
    if (node === null) return
    node.remove()
    node = null
    document.removeEventListener('keydown', onKey)
    const target = restoreFocus
    restoreFocus = null
    target?.focus?.()
  }

  /** 换内容但不重建容器：从列表点进回放时不该闪一下遮罩。 */
  function paint(body) {
    if (node === null) return
    const slot = node.querySelector('[data-role="m-history-body"]')
    if (slot === null) return
    slot.replaceChildren(body)
    slot.scrollTop = 0
  }

  function mount(title) {
    const closeButton = el(
      'button',
      {
        class: 'm-history__close',
        type: 'button',
        'aria-label': HISTORY_CLOSE_LABEL,
        dataset: { role: 'm-history-close' },
        onclick: () => close(),
      },
      [icon('close', 16)],
    )
    node = el(
      'div',
      {
        class: 'm-history-backdrop',
        'data-state': 'open',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '历史对话',
      },
      [
        el('section', { class: 'm-history' }, [
          el('header', { class: 'm-history__head' }, [
            el('h2', { class: 'm-history__title', text: title }),
            closeButton,
          ]),
          el('div', { class: 'm-history__body', dataset: { role: 'm-history-body' } }),
        ]),
      ],
    )
    host.append(node)
    document.addEventListener('keydown', onKey)
    closeButton.focus()
  }

  /** 打开列表。重复调用 = 刷新当前面板内容。 */
  async function open() {
    if (node === null) {
      restoreFocus = document.activeElement
      mount('历史对话')
    }
    paint(renderHistoryPanel({ loading: true, onOpen: (id) => void openSession(id) }))
    const result = await deps.loadList()
    if (node === null) return
    if (!result.ok) {
      paint(
        renderHistoryPanel({
          error: typeof result.reason === 'string' ? result.reason : '读取历史失败',
          onOpen: (id) => void openSession(id),
          onRefresh: () => void open(),
        }),
      )
      return
    }
    const sessions = result.data?.sessions
    paint(
      renderHistoryPanel({
        items: Array.isArray(sessions) ? sessions : [],
        onOpen: (id) => void openSession(id),
        onRefresh: () => void open(),
      }),
    )
  }

  /** 打开一个历史会话（只读）。失败退回列表——不留一个空白面板。 */
  async function openSession(sessionId) {
    paint(renderHistoryPanel({ loading: true, onOpen: (id) => void openSession(id) }))
    const result = await deps.loadSession(sessionId)
    if (node === null) return
    if (!result.ok) {
      paint(
        renderHistoryPanel({
          error: typeof result.reason === 'string' ? result.reason : '这个会话打不开',
          onOpen: (id) => void openSession(id),
          onRefresh: () => void open(),
        }),
      )
      return
    }
    const data = result.data ?? {}
    const title = typeof data.title === 'string' && data.title !== '' ? data.title : sessionId
    paint(
      renderReadonlyView({
        title,
        frames: Array.isArray(data.snapshot?.frames) ? data.snapshot.frames : [],
        renderFrame: deps.renderFrame,
        onBack: () => void open(),
      }),
    )
  }

  return {
    open,
    close,
    isOpen: () => node !== null,
  }
}
