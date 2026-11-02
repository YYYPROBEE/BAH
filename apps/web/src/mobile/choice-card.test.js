/**
 * 选择题卡片用例（TC-MOB-26）。
 *
 * 钉的是 D6 的语义边界：**点选 = 一条用户消息**，审批通道不参与。
 * 所以这里断言的是"发出去的是选项文本本身"，而不是"某个票据被批准了"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChoiceCard } from './choice-card.js'

function choiceFrame(overrides = {}) {
  return {
    kind: 'choice',
    seq: 3,
    at: 1000,
    callId: 'call-9',
    prompt: '你要转给谁？',
    options: [
      { id: 'o1', label: '王建国', hint: '上次那笔' },
      { id: 'o2', label: '李雷' },
      { id: 'o3', label: '韩梅梅' },
    ],
    allowFreeText: true,
    ...overrides,
  }
}

describe('选择题卡片', () => {
  let host
  let submit
  let echo
  let focusComposer
  let card

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    submit = vi.fn(async () => ({ ok: true, code: 'ok', message: '' }))
    echo = vi.fn(() => document.createElement('div'))
    focusComposer = vi.fn()
    card = createChoiceCard(host, { submit, echo, focusComposer })
  })

  afterEach(() => {
    card.dispose()
    host.remove()
  })

  const options = () => [...host.querySelectorAll('[data-role="choice-option"]')]
  const free = () => host.querySelector('[data-role="choice-free"]')

  async function flush() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }

  it('TC-MOB-26 渲染 ≤3 候选 + 必含"手动输入"出口', () => {
    card.show(choiceFrame())

    expect(options().length).toBe(3)
    expect(options().map((node) => node.textContent.trim())).toEqual(['王建国上次那笔', '李雷', '韩梅梅'])
    expect(free()).not.toBeNull()
    expect(free().textContent).toContain('手动输入')
    expect(host.querySelector('[data-role="choice"]').dataset.callId).toBe('call-9')
  })

  it('TC-MOB-26 超过 3 个候选被截断（D6 硬约束 ≤3）', () => {
    card.show(
      choiceFrame({
        options: [
          { id: 'a', label: '一' },
          { id: 'b', label: '二' },
          { id: 'c', label: '三' },
          { id: 'd', label: '四' },
        ],
      }),
    )

    expect(options().length).toBe(3)
    expect(options().map((node) => node.dataset.optionId)).toEqual(['a', 'b', 'c'])
  })

  it('TC-MOB-26 点候选 ⇒ 回显 + submit(选项文本) 恰一次 + 全部按钮立刻禁用（防双击）', async () => {
    let release
    submit.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    card.show(choiceFrame())

    options()[1].dispatchEvent(new Event('click'))
    expect(echo).toHaveBeenCalledTimes(1)
    expect(echo).toHaveBeenCalledWith('李雷')
    expect(options().every((node) => node.disabled)).toBe(true)
    expect(free().disabled).toBe(true)

    release({ ok: true, code: 'ok', message: '' })
    await flush()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('李雷')
    expect(host.querySelector('[data-role="choice"]').dataset.state).toBe('picked')
    expect(host.textContent).toContain('已选择：李雷')
  })

  it('TC-MOB-26 点"手动输入" ⇒ 零请求，只把焦点交给 composer（出口不是选项）', () => {
    card.show(choiceFrame())

    free().dispatchEvent(new Event('click'))

    expect(submit).toHaveBeenCalledTimes(0)
    expect(echo).toHaveBeenCalledTimes(0)
    expect(focusComposer).toHaveBeenCalledTimes(1)
  })

  it('open 只在等用户点选时为 true（选完把视口交还后续消息）', async () => {
    expect(card.open).toBe(false)
    card.show(choiceFrame())
    expect(card.open).toBe(true)

    submit.mockResolvedValue({ ok: true, code: 'ok', message: '' })
    options()[0].dispatchEvent(new Event('click'))
    await flush()
    expect(card.open).toBe(false)
  })

  it('TC-MOB-26 提交失败 ⇒ 按钮恢复可点 + inline 错误（不静默吞错）', async () => {
    submit.mockResolvedValue({ ok: false, code: 'turn-conflict-handoff', message: '会话已交人工接管' })
    card.show(choiceFrame())

    options()[0].dispatchEvent(new Event('click'))
    await flush()

    expect(options().every((node) => node.disabled === false)).toBe(true)
    const error = host.querySelector('[data-role="choice-error"]')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe('发送失败：会话已交人工接管')
    expect(error.getAttribute('role')).toBe('alert')

    // 恢复后可重试
    submit.mockResolvedValue({ ok: true, code: 'ok', message: '' })
    options()[0].dispatchEvent(new Event('click'))
    await flush()
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('失败后「重试发送」重发同一条选项（不猜别的候选）', async () => {
    submit.mockResolvedValueOnce({ ok: false, code: 'turn-failed', message: '网络中断' })
    submit.mockResolvedValue({ ok: true, code: 'ok', message: '' })
    card.show(choiceFrame())

    expect(host.querySelector('[data-role="choice-retry"]').hidden).toBe(true)

    options()[1].dispatchEvent(new Event('click'))
    await flush()

    const retry = host.querySelector('[data-role="choice-retry"]')
    expect(retry.hidden).toBe(false)
    expect(retry.getAttribute('aria-label')).toBe('重试发送')

    retry.dispatchEvent(new Event('click'))
    await flush()

    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenLastCalledWith('李雷')
    expect(host.querySelector('[data-role="choice"]').dataset.state).toBe('picked')
    expect(host.textContent).toContain('已选择：李雷')
  })

  it('在飞期间连点只发一次（防双击的第二道闸，不只靠 disabled）', async () => {
    let release
    submit.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    card.show(choiceFrame())

    options()[0].dispatchEvent(new Event('click'))
    options()[0].dispatchEvent(new Event('click'))
    release({ ok: true })
    await flush()

    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('同帧重复 show 幂等（SSE 重连补发不重置用户已点选的结果）', async () => {
    const frame = choiceFrame()
    card.show(frame)
    options()[0].dispatchEvent(new Event('click'))
    await flush()
    expect(host.querySelector('[data-role="choice"]').dataset.state).toBe('picked')

    card.show(frame)
    expect(host.querySelector('[data-role="choice"]').dataset.state).toBe('picked')
    expect(host.querySelectorAll('[data-role="choice"]').length).toBe(1)
  })

  it('新一帧替换旧卡片（一次只留一张选择题）', () => {
    card.show(choiceFrame())
    card.show(choiceFrame({ callId: 'call-10', prompt: '换一个问题' }))

    expect(host.querySelectorAll('[data-role="choice"]').length).toBe(1)
    expect(host.textContent).toContain('换一个问题')
    expect(card.frame.callId).toBe('call-10')
  })

  it('卡片里没有票据相关字段（D6：有 ticketId 就会被误当成审批）', () => {
    card.show(choiceFrame())

    expect(host.innerHTML).not.toContain('ticketId')
    expect(host.querySelectorAll('[data-role="approve"], [data-role="reject"]').length).toBe(0)
  })
})
