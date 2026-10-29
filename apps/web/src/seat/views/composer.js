/**
 * 坐席台底部：发言框 + 交回表单（B2/B5）。
 *
 * 两条纪律：
 * 1. **不乐观渲染**：发送成功后不本地插气泡，等 SSE 推 `handoff/operator-message` 回来——
 *    两处各画一次必然对不上。
 * 2. **失败必须可见**：409/413 不静默，成 toast（I22）。
 */

import { el, icon } from '../../dom.js'

/** 交接语模板（预填、可改；清空 = 不写交接语）。 */
export const HANDOVER_TEMPLATE =
  '【人工坐席交接】客户刚才与坐席沟通，已确认：（请补充已确认的信息）。请在此基础上继续，不要重复询问已确认的信息。'

/**
 * @param {{
 *   onSend: (text: string) => Promise<{ ok: boolean, code?: string }>,
 *   onResume: (handover: string) => Promise<{ ok: boolean, code?: string }>,
 *   notify: (message: string, level?: string) => void,
 *   confirmResume?: (message: string) => boolean,
 * }} options
 */
export function createComposerView(options) {
  const input = el('textarea', {
    class: 'ds-textarea seat-composer__input',
    rows: 2,
    placeholder: '输入回复…（Enter 发送，Shift+Enter 换行）',
    'aria-label': '回复客户',
    disabled: true,
  })
  const sendButton = el(
    'button',
    { class: 'ds-btn ds-btn--brand ds-btn--md seat-composer__send', type: 'submit', disabled: true },
    [icon('send', 16), '发送'],
  )
  const count = el('span', { class: 'seat-composer__count', text: '已发言 0 条' })
  const overdue = el('div', { class: 'seat-badge seat-badge--overdue', hidden: true, text: '已超 SLA（3 分钟未处理），建议尽快响应' })
  const sendForm = el('form', { class: 'seat-composer__send-form' }, [
    input,
    el('div', { class: 'seat-composer__actions' }, [count, sendButton]),
  ])

  const handover = el('textarea', {
    class: 'ds-textarea seat-composer__handover',
    rows: 2,
    'aria-label': '交接语',
    disabled: true,
  })
  // textarea 的初始内容必须写 value 属性（setAttribute('value') 不生效）
  handover.value = HANDOVER_TEMPLATE
  const resumeButton = el(
    'button',
    { class: 'ds-btn ds-btn--secondary ds-btn--sm', type: 'button', disabled: true },
    [icon('check', 14), '交回智能助手'],
  )
  const resumeForm = el('div', { class: 'seat-composer__resume' }, [
    el('div', { class: 'seat-composer__resume-title', text: '交接语（交回时写进模型历史）' }),
    handover,
    el('div', { class: 'seat-composer__actions' }, [resumeButton]),
  ])

  const node = el('section', { class: 'seat-composer', 'aria-label': '坐席回复区' }, [
    overdue,
    sendForm,
    resumeForm,
  ])

  sendForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (text === '') return
    sendButton.disabled = true
    const result = await options.onSend(text)
    sendButton.disabled = false
    if (!result.ok) {
      options.notify(
        result.code === 'handoff-text-too-long'
          ? '太长了（上限 2000 字），请分段发送'
          : `发送失败：${String(result.code ?? 'unknown')}`,
        'danger',
      )
      return
    }
    input.value = ''
    input.style.height = ''
  })

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendForm.requestSubmit()
    }
  })

  resumeButton.addEventListener('click', async () => {
    const confirmFn = options.confirmResume ?? ((message) => globalThis.confirm(message))
    if (!confirmFn('确认交回给智能助手？客户会看到你填的交接说明。')) return
    resumeButton.disabled = true
    const result = await options.onResume(handover.value)
    resumeButton.disabled = false
    if (!result.ok) options.notify(`交回失败：${String(result.code ?? 'unknown')}`, 'danger')
  })

  /**
   * @param {{ summary: Record<string, any> | null, heartbeat: { waitedMs: number, overdue: boolean } | null }} view
   */
  function update(view) {
    const active = view.summary?.active === true
    input.disabled = !active
    sendButton.disabled = !active
    handover.disabled = !active
    resumeButton.disabled = !active
    count.textContent = `已发言 ${String(view.summary?.operatorMessages ?? 0)} 条`
    const isOverdue = view.heartbeat?.overdue === true || view.summary?.overdue === true
    overdue.hidden = !isOverdue
  }

  return { node, update, focus: () => input.focus() }
}
