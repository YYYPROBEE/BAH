/**
 * 选择题卡用例（`choice` 帧 → 桌面壳卡片）。
 *
 * 钉住三条语义（`frames.ts` 的 `ChoiceFrame`）：
 * 1. 点选 = 把选项 **label** 当普通用户消息发出去（不是 id、不是审批结论）；
 * 2. `allowFreeText` 恒真 ⇒ "手动输入"出口永远在，且它是出口（零请求、只交焦点）；
 * 3. 发送失败不静默：恢复可点 + 行内错误。
 */

import { describe, expect, it, vi } from 'vitest'

import { renderChoiceCard } from './choice-card.js'

/** 造一条选择题帧。 */
function choice(overrides = {}) {
  return {
    kind: 'choice',
    seq: 107,
    at: 1_793_332_963_643,
    callId: 'call-ask',
    prompt: '要转给谁？请给出收款人姓名。',
    options: [
      { id: '王建国', label: '王建国' },
      { id: '张伟', label: '张伟' },
    ],
    allowFreeText: true,
    ...overrides,
  }
}

/** 等异步点击落定。 */
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('选择题卡 · 渲染', () => {
  it('渲染问题与全部候选（label 可见）', () => {
    const node = renderChoiceCard(choice(), { submit: async () => ({ ok: true }) })
    expect(node.dataset.role).toBe('choice')
    expect(node.dataset.callId).toBe('call-ask')
    expect(node.textContent).toContain('要转给谁？')
    const labels = [...node.querySelectorAll('[data-role="choice-option"]')].map((button) => button.textContent)
    expect(labels[0]).toContain('王建国')
    expect(labels[1]).toContain('张伟')
  })

  it('一屏最多三个候选；"手动输入"出口不占位', () => {
    const options = ['甲', '乙', '丙', '丁'].map((label) => ({ id: label, label }))
    const node = renderChoiceCard(choice({ options }), { submit: async () => ({ ok: true }) })
    expect(node.querySelectorAll('[data-role="choice-option"]')).toHaveLength(3)
    expect(node.querySelector('[data-role="choice-free"]')).not.toBeNull()
  })

  it('候选一个都没有时仍保留手动输入出口（不能被卡死）', () => {
    const node = renderChoiceCard(choice({ options: [] }), { submit: async () => ({ ok: true }) })
    expect(node.querySelectorAll('[data-role="choice-option"]')).toHaveLength(0)
    expect(node.querySelector('[data-role="choice-free"]')).not.toBeNull()
  })

  it('候选提示（hint）作为副行渲染', () => {
    const node = renderChoiceCard(
      choice({ options: [{ id: 'p1', label: '张伟', hint: '尾号 8899' }] }),
      { submit: async () => ({ ok: true }) },
    )
    expect(node.querySelector('.choice-card__option-hint').textContent).toBe('尾号 8899')
  })

  it('没接发送通道时候选禁用（不假装可点）', () => {
    const node = renderChoiceCard(choice())
    for (const button of node.querySelectorAll('[data-role="choice-option"]')) {
      expect(button.disabled).toBe(true)
    }
  })

  it('模型给的文本只作文本节点（HTML 不执行）', () => {
    const evil = '<img src=x onerror="window.__pwned=1">'
    const node = renderChoiceCard(
      choice({ prompt: evil, options: [{ id: evil, label: evil, hint: evil }] }),
      { submit: async () => ({ ok: true }) },
    )
    expect(node.querySelector('img')).toBeNull()
    expect(node.textContent).toContain(evil)
  })
})

describe('选择题卡 · 点选', () => {
  it('点选发送的是选项 label（不是 id）', async () => {
    const submit = vi.fn(async () => ({ ok: true }))
    const node = renderChoiceCard(
      choice({ options: [{ id: 'payee-zhang', label: '张伟' }] }),
      { submit },
    )
    node.querySelector('[data-role="choice-option"]').click()
    await settle()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('张伟')
  })

  it('发送成功：卡片收成"已选择"，候选不再可点', async () => {
    const node = renderChoiceCard(choice(), { submit: async () => ({ ok: true }) })
    node.querySelector('[data-option-id="张伟"]').click()
    await settle()

    expect(node.dataset.state).toBe('picked')
    expect(node.textContent).toContain('已选择：张伟')
    expect(node.querySelectorAll('[data-role="choice-option"]')).toHaveLength(0)
  })

  it('发送失败：恢复可点 + 行内错误（不静默吞错）', async () => {
    const node = renderChoiceCard(choice(), {
      submit: async () => ({ ok: false, code: 'turn-rate-limited', message: '请求过于频繁，请稍后再试' }),
    })
    const option = node.querySelector('[data-option-id="张伟"]')
    option.click()
    await settle()

    expect(node.dataset.state).toBe('open')
    expect(option.disabled).toBe(false)
    const error = node.querySelector('[role="alert"]')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('请求过于频繁')
  })

  it('失败后「重试发送」只重发同一条选项；成功后错误与重试一起收起', async () => {
    let attempt = 0
    const submit = vi.fn(async () => {
      attempt += 1
      return attempt === 1 ? { ok: false, code: 'turn-failed', message: '网络中断' } : { ok: true }
    })
    const node = renderChoiceCard(choice(), { submit })
    const retry = node.querySelector('[data-role="choice-retry"]')
    expect(retry.hidden).toBe(true)

    node.querySelector('[data-option-id="张伟"]').click()
    await settle()

    const error = node.querySelector('[role="alert"]')
    expect(error.hidden).toBe(false)
    expect(retry.hidden).toBe(false)

    retry.click()
    await settle()

    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenLastCalledWith('张伟')
    expect(node.dataset.state).toBe('picked')
    expect(node.textContent).toContain('已选择：张伟')
  })

  it('在飞时重复点击只发一次（窄屏双击同 desktop 双击）', async () => {
    let release = () => undefined
    const submit = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true })
        }),
    )
    const node = renderChoiceCard(choice(), { submit })
    const option = node.querySelector('[data-option-id="张伟"]')
    option.click()
    option.click()
    option.click()
    await Promise.resolve()

    expect(submit).toHaveBeenCalledTimes(1)
    release()
    await settle()
    expect(node.dataset.state).toBe('picked')
  })

  it('"手动输入"只交还焦点：零请求', () => {
    const submit = vi.fn(async () => ({ ok: true }))
    const focusComposer = vi.fn()
    const node = renderChoiceCard(choice(), { submit, focusComposer })
    node.querySelector('[data-role="choice-free"]').click()

    expect(submit).not.toHaveBeenCalled()
    expect(focusComposer).toHaveBeenCalledTimes(1)
  })
})
