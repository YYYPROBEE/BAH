/**
 * 选择题卡（`choice` 帧，桌面壳）。
 *
 * 语义边界与 `packages/channels/src/web/frames.ts` 的 `ChoiceFrame` 注释同一条：
 * 追问**不走审批通道**——帧里刻意没有 `ticketId`、没有 responder。点选就是把选项
 * `label` 当**普通用户消息**发 `POST /api/turn`，与手打一句话完全同一条路径。
 *
 * 与移动壳的唯一差别是回显：桌面壳不做本地注入（`main.js` 的纪律），用户消息一律等
 * `user/message` 帧；发送成功只把卡片收成"已选择"，气泡交给帧。
 *
 * `allowFreeText` 在契约里是字面量 `true`：无论候选有几个，"手动输入"出口都必须保留——
 * 三个候选都不对时用户不能被卡死。它是出口不是选项，点击零请求，只把焦点交回输入框。
 */

import { clear, el, icon } from '../dom.js'

/** 一屏最多三个业务候选（`frames.ts` 的 D6 硬约束；手动输入出口不占位）。 */
const MAX_OPTIONS = 3

/**
 * `choice` 帧 → 卡片节点。
 *
 * @param {Record<string, any>} frame
 * @param {{
 *   submit?: (text: string) => Promise<{ok: boolean, code?: string, message?: string, reason?: string}>,
 *   focusComposer?: () => void,
 * }} [deps] `submit` 缺省时候选按钮禁用（不假装可点）
 * @returns {HTMLElement}
 */
export function renderChoiceCard(frame, deps = {}) {
  const submit = typeof deps.submit === 'function' ? deps.submit : null
  const focusComposer = typeof deps.focusComposer === 'function' ? deps.focusComposer : null
  const optionsBox = el('div', { class: 'choice-card__options', dataset: { role: 'choice-options' } })
  const errorText = el('span', { class: 'choice-card__error-text', dataset: { role: 'choice-error-text' } })
  const retry = el('button', {
    class: 'choice-card__retry',
    type: 'button',
    'aria-label': '重试发送',
    title: '重试发送',
    dataset: { role: 'choice-retry' },
    hidden: true,
  }, [icon('refresh', 14)])
  const error = el('div', { class: 'choice-card__error', role: 'alert', hidden: true }, [errorText, retry])
  let failedLabel = null
  retry.addEventListener('click', () => {
    if (failedLabel === null) return
    error.hidden = true
    retry.hidden = true
    void pick(failedLabel)
  })
  const section = el(
    'section',
    {
      class: 'ds-card choice-card',
      dataset: { role: 'choice', callId: frame.callId, state: 'open' },
      'aria-label': '选择题',
    },
    [
      el('p', { class: 'choice-card__prompt' }, [icon('message', 16), el('span', { text: frame.prompt })]),
      optionsBox,
      error,
    ],
  )

  /** 当前卡片上的全部可点项（防双击时一并禁用）。 */
  const buttons = []
  let inFlight = false

  async function pick(label) {
    if (submit === null || inFlight) return
    inFlight = true
    error.hidden = true
    retry.hidden = true
    for (const button of buttons) button.disabled = true
    const result = await submit(label)
    if (result?.ok === true) {
      failedLabel = null
      section.dataset.state = 'picked'
      clear(optionsBox)
      optionsBox.append(el('p', { class: 'ds-tag ds-tag--success', text: `已选择：${label}` }))
      return
    }
    // 失败不静默吞：恢复可点 + 行内错误（结构化理由优先，绝不显示空错误）
    inFlight = false
    failedLabel = label
    for (const button of buttons) button.disabled = false
    error.hidden = false
    errorText.textContent = `发送失败：${String(result?.message ?? result?.reason ?? result?.code ?? 'unknown')}`
    retry.hidden = false
  }

  for (const option of (frame.options ?? []).slice(0, MAX_OPTIONS)) {
    const button = el(
      'button',
      {
        class: 'choice-card__option',
        type: 'button',
        dataset: { role: 'choice-option', optionId: String(option.id) },
        disabled: submit === null,
        onclick: () => void pick(option.label),
      },
      [
        icon('right', 16),
        el('span', { class: 'choice-card__option-text' }, [
          el('span', { text: option.label }),
          ...(option.hint === undefined
            ? []
            : [el('span', { class: 'choice-card__option-hint', text: option.hint })]),
        ]),
      ],
    )
    buttons.push(button)
  }

  const freeButton = el(
    'button',
    {
      class: 'choice-card__option choice-card__option--free',
      type: 'button',
      dataset: { role: 'choice-free' },
      disabled: focusComposer === null,
      onclick: () => focusComposer?.(),
    },
    [icon('doc', 16), el('span', { text: '手动输入' })],
  )
  buttons.push(freeButton)

  optionsBox.append(...buttons)
  return section
}
