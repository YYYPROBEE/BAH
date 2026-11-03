/**
 * 风险问卷卡用例（`risk-questionnaire` 帧 → 桌面/移动共用的问卷卡）。
 *
 * 钉住四条语义（`frames.ts` 的 `RiskQuestionnaireFrame`）：
 * 1. **不答满不许提交**：半份问卷拿不到有效等级，按钮必须禁用；
 * 2. 同题互斥：一题只能有一个选中项（改选不累加）；
 * 3. 提交内容是一条**可回放的用户消息**：`风险测评作答 <问卷ID> 1=key …`；
 * 4. 发送失败不静默：恢复可点 + 行内错误。
 */

import { describe, expect, it, vi } from 'vitest'

import { renderRiskQuestionnaire } from './risk-form.js'

/** 造一张问卷帧（5 题 × 3 选项，与 `core/risk-questionnaire.ts` 同形）。 */
function questionnaire(overrides = {}) {
  return {
    kind: 'risk-questionnaire',
    seq: 301,
    at: 1_793_332_963_643,
    callId: 'call-risk',
    questionnaireId: 'rq-1',
    version: 'risk-q/v1',
    expiresAt: 1_793_333_863_643,
    questions: [1, 2, 3, 4, 5].map((index) => ({
      index,
      title: `第 ${index} 题的题干`,
      options: [
        { key: 'conservative', text: '保守', score: 1 },
        { key: 'middle', text: '中间', score: 3 },
        { key: 'aggressive', text: '激进', score: 5 },
      ],
    })),
    ...overrides,
  }
}

/** 等异步点击落定。 */
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** 点一题的某个选项。 */
function pick(card, index, key) {
  const button = card.querySelector(
    `[data-role="risk-option"][data-index="${String(index)}"][data-key="${key}"]`,
  )
  expect(button).not.toBeNull()
  button.click()
}

describe('renderRiskQuestionnaire', () => {
  it('5 题全部渲染，每题 3 个选项；未答满时提交禁用', () => {
    const card = renderRiskQuestionnaire(questionnaire(), { submit: vi.fn() })
    expect(card.dataset.role).toBe('risk-questionnaire')
    expect(card.dataset.questionnaireId).toBe('rq-1')
    expect(card.querySelectorAll('[data-role="risk-option"]')).toHaveLength(15)
    const submit = card.querySelector('.risk-form__submit')
    expect(submit.disabled).toBe(true)
    expect(card.querySelector('[role="status"]').textContent).toContain('0 / 5')
  })

  it('同一题改选只保留最后一个；答满后提交可用', () => {
    const card = renderRiskQuestionnaire(questionnaire(), { submit: vi.fn() })
    pick(card, 1, 'aggressive')
    pick(card, 1, 'conservative')
    const selected = card.querySelectorAll('[data-index="1"] [data-selected="true"]')
    expect(selected).toHaveLength(1)
    expect(selected[0].dataset.key).toBe('conservative')

    for (const index of [2, 3, 4, 5]) pick(card, index, 'middle')
    expect(card.querySelector('.risk-form__submit').disabled).toBe(false)
    expect(card.querySelector('[role="status"]').textContent).toContain('5 / 5')
  })

  it('提交文本是 `风险测评作答 <ID> n=key …`（可被 router 逐字解析）', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true })
    const card = renderRiskQuestionnaire(questionnaire(), { submit })
    const keys = ['conservative', 'middle', 'aggressive', 'middle', 'conservative']
    keys.forEach((key, position) => pick(card, position + 1, key))
    card.querySelector('.risk-form__submit').click()
    await settle()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toBe(
      '风险测评作答 rq-1 1=conservative 2=middle 3=aggressive 4=middle 5=conservative',
    )
    expect(card.dataset.state).toBe('submitted')
    // 提交后全卡禁用：不允许再改一次再发（同一张卷只能核销一次）
    for (const button of card.querySelectorAll('button')) expect(button.disabled).toBe(true)
  })

  it('没有 submit 时选项禁用（不假装可点）', () => {
    const card = renderRiskQuestionnaire(questionnaire())
    for (const button of card.querySelectorAll('[data-role="risk-option"]')) {
      expect(button.disabled).toBe(true)
    }
    expect(card.querySelector('.risk-form__submit').disabled).toBe(true)
  })

  it('发送失败：恢复可点 + 行内错误（不静默吞）', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: false, code: 'network-error' })
    const card = renderRiskQuestionnaire(questionnaire(), { submit })
    for (const index of [1, 2, 3, 4, 5]) pick(card, index, 'middle')
    card.querySelector('.risk-form__submit').click()
    await settle()

    const error = card.querySelector('[role="alert"]')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('network-error')
    expect(card.querySelector('.risk-form__submit').disabled).toBe(false)
  })
})
