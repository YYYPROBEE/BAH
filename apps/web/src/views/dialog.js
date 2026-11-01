/**
 * 桌面帮助弹窗（服务说明 / 无障碍入口）。
 *
 * 与审批弹窗分开：审批有票据状态机与安全默认，本弹窗只是只读说明，
 * 因此允许点背景关闭、Esc 关闭；但焦点仍要被困在弹窗内并在关闭后归还。
 */

import { el, icon } from '../dom.js'

let nextId = 1

/**
 * @param {HTMLElement} host 遮罩挂载点
 * @param {{ onClose?: () => void }} [options]
 */
export function createDialog(host, options = {}) {
  const backdrop = el('div', { class: 'ui-dialog-backdrop', dataset: { role: 'dialog-backdrop' }, hidden: true })
  host.append(backdrop)

  let panel = null
  let restoreFocus = null
  let open = false

  function focusables() {
    if (panel === null) return []
    return [...panel.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
      (node) => node.hidden !== true && node.disabled !== true,
    )
  }

  function onKey(event) {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const list = focusables()
    if (list.length === 0) return
    const first = list[0]
    const last = list[list.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  /** 关闭（可重复调用）。 */
  function close() {
    if (!open) return
    open = false
    backdrop.hidden = true
    backdrop.replaceChildren()
    panel = null
    document.removeEventListener('keydown', onKey)
    const target = restoreFocus
    restoreFocus = null
    target?.focus?.()
    options.onClose?.()
  }

  /**
   * 打开。
   *
   * @param {{ title: string, body: HTMLElement }} content
   */
  function show(content) {
    close()
    restoreFocus = document.activeElement
    const titleId = `ui-dialog-title-${String(nextId)}`
    nextId += 1
    const closeButton = el('button', {
      class: 'ui-dialog__close',
      type: 'button',
      'aria-label': '关闭',
      dataset: { role: 'dialog-close' },
    }, [icon('close', 16)])
    closeButton.addEventListener('click', close)

    panel = el('div', {
      class: 'ui-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      dataset: { role: 'dialog' },
    }, [
      el('header', { class: 'ui-dialog__head' }, [
        el('h2', { class: 'ui-dialog__title', id: titleId, text: content.title }),
        closeButton,
      ]),
      el('div', { class: 'ui-dialog__body' }, [content.body]),
    ])
    backdrop.replaceChildren(panel)
    backdrop.hidden = false
    open = true
    document.addEventListener('keydown', onKey)
    closeButton.focus()
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close()
  })

  return {
    show,
    close,
    get open() {
      return open
    },
    node: backdrop,
    dispose() {
      close()
      backdrop.remove()
    },
  }
}
