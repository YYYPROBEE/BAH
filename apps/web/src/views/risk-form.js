/**
 * 风险问卷卡（`risk-questionnaire` 帧，桌面壳与移动壳共用）。
 *
 * 语义边界与 `packages/channels/src/web/frames.ts` 的 `RiskQuestionnaireFrame` 注释同一条：
 * 这张卡**不是审批**——没有票据、点选不发钱；答完只是把一条普通用户消息发
 * `POST /api/turn`（`风险测评作答 <问卷ID> 1=key 2=key …`），与手打一句话完全同一条路径。
 * 真正的确认闸是随后的审批卡（逐题回显 + 批准），所以这里不写"已提交"之类的完成态，
 * 只把卡片收成"已作答"。
 *
 * 纪律：**不在前端算分**。分值随帧下发，只用于展示；合计与等级变化由服务端在审批卡里给。
 */

import { el, icon } from '../dom.js'

/**
 * `risk-questionnaire` 帧 → 卡片节点。
 *
 * @param {Record<string, any>} frame
 * @param {{
 *   submit?: (text: string) => Promise<{ok: boolean, code?: string, message?: string, reason?: string}>,
 * }} [deps] `submit` 缺省时选项禁用（不假装可点）
 * @returns {HTMLElement}
 */
export function renderRiskQuestionnaire(frame, deps = {}) {
  const submit = typeof deps.submit === 'function' ? deps.submit : null
  /** @type {Map<number, string>} 题号 → 选项键 */
  const chosen = new Map()
  let inFlight = false

  const error = el('p', { class: 'risk-form__error', role: 'alert', hidden: true })
  const progress = el('p', { class: 'risk-form__progress', role: 'status' })
  const submitButton = el('button', {
    class: 'risk-form__submit',
    type: 'button',
    disabled: true,
    text: '提交测评',
    onclick: () => void send(),
  })

  const section = el(
    'section',
    {
      class: 'ds-card risk-form',
      dataset: {
        role: 'risk-questionnaire',
        callId: frame.callId,
        questionnaireId: frame.questionnaireId,
      },
      'aria-label': '风险测评问卷',
    },
    [
      el('h3', { class: 'risk-form__title' }, [
        icon('doc', 16),
        el('span', { text: `风险测评（共 ${frame.questions.length} 题）` }),
      ]),
      el('p', {
        class: 'risk-form__hint',
        text: '请由本人逐题选择；提交后还会有一张审批卡逐题回显，确认后才会更新风险等级。',
      }),
      ...frame.questions.map(renderQuestion),
      progress,
      error,
      submitButton,
    ],
  )

  /** 一道题（三个选项以内，单选）。 */
  function renderQuestion(question) {
    const options = el('div', { class: 'risk-form__options', role: 'radiogroup' })
    for (const option of question.options) {
      const button = el('button', {
        class: 'risk-form__option',
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        dataset: { role: 'risk-option', index: String(question.index), key: option.key },
        disabled: submit === null,
        onclick: () => pick(question.index, option.key),
      }, [
        el('span', { class: 'risk-form__option-text', text: option.text }),
      ])
      options.append(button)
    }
    return el('fieldset', { class: 'risk-form__question', dataset: { index: String(question.index) } }, [
      el('legend', { text: `第 ${question.index} 题 ${question.title}` }),
      options,
    ])
  }

  /** 选中一题：同题互斥，只改 `aria-checked`，不重排 DOM。 */
  function pick(index, key) {
    if (inFlight) return
    chosen.set(index, key)
    const fieldset = section.querySelector(`[data-index="${String(index)}"]`)
    if (fieldset !== null) {
      for (const button of fieldset.querySelectorAll('[data-role="risk-option"]')) {
        const active = button.dataset.key === key
        button.dataset.selected = active ? 'true' : 'false'
        button.setAttribute('aria-checked', active ? 'true' : 'false')
      }
    }
    refresh()
  }

  /** 进度与可提交状态（未答满不许提交：半份问卷拿不到有效等级）。 */
  function refresh() {
    const total = frame.questions.length
    progress.textContent = `已作答 ${chosen.size} / ${total} 题`
    submitButton.disabled = submit === null || chosen.size < total || inFlight
  }

  /** 拼作答文本并发送（格式由 `packages/llm/src/demo/router.ts` 的 `parseRiskSubmit` 解析）。 */
  async function send() {
    if (submit === null || inFlight || chosen.size < frame.questions.length) return
    inFlight = true
    error.hidden = true
    submitButton.disabled = true
    const answers = frame.questions
      .map((question) => `${String(question.index)}=${String(chosen.get(question.index))}`)
      .join(' ')
    const result = await submit(`风险测评作答 ${frame.questionnaireId} ${answers}`)
    if (result?.ok === true) {
      section.dataset.state = 'submitted'
      submitButton.textContent = '已提交'
      for (const button of section.querySelectorAll('button')) button.disabled = true
      return
    }
    inFlight = false
    refresh()
    error.hidden = false
    error.textContent = `提交失败：${String(result?.message ?? result?.reason ?? result?.code ?? 'unknown')}`
  }

  refresh()
  return section
}
