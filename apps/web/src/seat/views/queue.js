/**
 * 坐席台左栏：待接管列表（B2/B5）。
 *
 * 单会话部署 ⇒ 列表长度恒 0 或 1；显示会话 ID、等待时长、认领状态、进入原因、
 * 待审批票据数——少一个坐席就得靠猜。
 */

import { el, icon } from '../../dom.js'
import { formatWaited } from '../../format.js'

export function createQueueView({ onClaim }) {
  const body = el('div', { class: 'seat-queue__body' })
  const node = el('aside', { class: 'seat-queue', 'aria-label': '待接管会话' }, [
    el('div', { class: 'seat-queue__title' }, [
      el('span', { class: 'seat-queue__title-text', text: '待接管' }),
    ]),
    body,
  ])

  let claiming = false

  function empty() {
    body.replaceChildren(
      el('div', { class: 'ds-empty' }, [
        el('p', { class: 'ds-empty__title', text: '暂无待接管会话' }),
        el('p', { class: 'ds-empty__desc', text: '客户请求转人工后会出现在这里。' }),
      ]),
    )
  }

  /**
   * @param {{
   *   summary: Record<string, any> | null,
   *   heartbeat: { waitedMs: number, overdue: boolean } | null,
   *   queue: { depth: number, items: any[] } | null,
   * }} view
   */
  function update(view) {
    const summary = view.summary
    if (summary === null || summary === undefined || summary.active !== true) {
      empty()
      return
    }
    const waitedMs = view.heartbeat?.waitedMs ?? summary.waitedMs ?? 0
    const overdue = view.heartbeat?.overdue === true || summary.overdue === true
    const claimed = summary.claimed === true
    const claimButton = el(
      'button',
      {
        class: 'ds-btn ds-btn--secondary ds-btn--sm seat-queue__claim',
        type: 'button',
        disabled: claimed || claiming,
        onclick: async () => {
          if (claiming) return
          claiming = true
          claimButton.disabled = true
          try {
            await onClaim()
          } finally {
            claiming = false
          }
        },
      },
      [icon('check', 14), claimed ? '已认领' : '认领'],
    )

    body.replaceChildren(
      el('div', { class: 'seat-queue__card' }, [
        el('div', { class: 'seat-queue__session', text: summary.sessionId }),
        el('div', { class: 'seat-queue__row' }, [
          el('span', { class: 'seat-queue__label', text: '等待' }),
          el('span', { class: `seat-queue__value${overdue ? ' seat-queue__value--overdue' : ''}`, text: formatWaited(waitedMs) }),
        ]),
        el('div', { class: 'seat-queue__row' }, [
          el('span', { class: 'seat-queue__label', text: '认领' }),
          el('span', {
            class: 'seat-queue__value',
            text: claimed ? `${String(summary.operator ?? '坐席')} 处理中` : '未认领',
          }),
        ]),
        el('div', { class: 'seat-queue__row' }, [
          el('span', { class: 'seat-queue__label', text: '票据' }),
          el('span', { class: 'seat-queue__value', text: `待审批 ${String(summary.pendingTickets ?? 0)} 张` }),
        ]),
        ...(summary.reason === undefined
          ? []
          : [
              el('div', { class: 'seat-queue__reason' }, [
                el('span', { class: 'seat-queue__label', text: '原因' }),
                el('span', { class: 'seat-queue__reason-text', text: summary.reason }),
              ]),
            ]),
        claimButton,
      ]),
    )
  }

  return { node, update }
}
