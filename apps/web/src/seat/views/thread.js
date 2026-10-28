/**
 * 坐席台中间：对话流（B2）。
 *
 * **复用客户页的 `renderMessage`**：01 已把 `role:'operator'` 加进帧类型，
 * 同一个渲染函数对坐席台也正确（自己的话是 operator 气泡，客户的话是 user 气泡）。
 * 这里只多做两件事：按 `seq` 合并"已转人工/已交回"分隔线；自动贴底滚动。
 */

import { el } from '../../dom.js'
import { formatWaited } from '../../format.js'
import { CONVERSATION_KINDS, renderFrame } from '../../views/conversation.js'

export function createThreadView() {
  const list = el('section', { class: 'conversation seat-thread', 'aria-label': '对话流' })
  const node = el('div', { class: 'seat-thread-wrap' }, [list])

  function divider(handoff) {
    const label =
      handoff.active === true
        ? `已转人工（等待 ${formatWaited(Date.now() - handoff.at)}）`
        : '已交回智能助手'
    return el('div', { class: 'seat-divider', dataset: { handoff: String(handoff.active) } }, [
      el('span', { class: 'seat-divider__line' }),
      el('span', { class: 'seat-divider__label', text: label }),
      el('span', { class: 'seat-divider__line' }),
    ])
  }

  /**
   * @param {{ frames: Record<string, any>[], handoff: Record<string, any> | null }} view
   */
  function update(view) {
    const items = view.frames
      .filter((frame) => CONVERSATION_KINDS.has(frame.kind))
      .map((frame) => ({ seq: frame.seq ?? 0, node: renderFrame(frame) }))
    if (view.handoff !== null && view.handoff !== undefined) {
      items.push({ seq: view.handoff.seq ?? 0, node: divider(view.handoff) })
    }
    items.sort((a, b) => a.seq - b.seq)

    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    if (items.length === 0) {
      list.replaceChildren(
        el('div', { class: 'conversation__empty' }, [
          el('p', { class: 'conversation__empty-title', text: '还没有对话' }),
          el('p', { class: 'conversation__empty-desc', text: '客户转人工后，完整对话会出现在这里。' }),
        ]),
      )
      return
    }
    list.replaceChildren(...items.map((item) => item.node))
    if (atBottom) list.scrollTop = list.scrollHeight
  }

  return { node, update }
}
