/**
 * 坐席台顶部状态条（B2/B5）。
 *
 * 只显示"连接态 + 会话 + 待接管数"三件事：坐席第一眼要知道"我连上了吗 / 这是哪个会话"。
 */

import { BRAND } from '../../brand.js'
import { el, icon } from '../../dom.js'

const STATUS = {
  connecting: { label: '连接中', cls: 'is-connecting' },
  online: { label: '已连接', cls: 'is-online' },
  offline: { label: '已断开（自动重连）', cls: 'is-offline' },
}

export function createStatusView() {
  const session = el('span', { class: 'seat-header__session', text: '会话 —' })
  const dot = el('span', { class: 'seat-header__dot is-connecting' })
  const label = el('span', { class: 'seat-header__status-text', text: STATUS.connecting.label })
  const node = el('header', { class: 'seat-header' }, [
    el('div', { class: 'seat-header__brand' }, [
      el('span', { class: 'seat-header__logo' }, [icon('bank', 20)]),
      el('div', {}, [
        el('div', { class: 'seat-header__title', text: BRAND.seat }),
        el('div', { class: 'seat-header__subtitle', text: '人工接管 · 单会话部署' }),
      ]),
    ]),
    el('div', { class: 'seat-header__meta' }, [
      session,
      el('span', { class: 'seat-header__status' }, [dot, label]),
    ]),
  ])

  function update({ sessionId, status }) {
    session.textContent = sessionId === undefined ? '会话 —' : `会话 ${String(sessionId)}`
    const view = STATUS[status] ?? STATUS.connecting
    dot.className = `seat-header__dot ${view.cls}`
    label.textContent = view.label
  }

  return { node, update }
}

