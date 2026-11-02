/**
 * 输入区用例（TC-MOB-28 的 composer 半边 + 发送/中断/自增高）。
 *
 * 桩纪律：`submit`/`interrupt` 是 spy，形状为 shell 归一化后的
 * `{ ok, code, message, retryAfterSeconds? }`（§3.0）。生产路径由 shell.js 用真实 transport 组装。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_INPUT_HEIGHT_PX, createComposer } from './composer.js'

function keyDown(init = {}) {
  return new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
}

describe('输入区', () => {
  let host
  let submit
  let interrupt
  let composer

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    submit = vi.fn(async () => ({ ok: true, code: 'ok', message: '' }))
    interrupt = vi.fn(async () => ({ ok: true, code: 'ok', message: '' }))
    composer = createComposer(host, { submit, interrupt, imeDeps: { storage: undefined } })
  })

  afterEach(() => {
    composer.dispose()
    host.remove()
    vi.useRealTimers()
  })

  const input = () => host.querySelector('[data-role="composer-input"]')
  const send = () => host.querySelector('[data-role="send"]')
  const stop = () => host.querySelector('[data-role="interrupt"]')
  const errorText = () => {
    const node = host.querySelector('[data-role="composer-error"]')
    return node.hidden ? null : node.textContent
  }

  async function flush() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }

  it('点发送 ⇒ POST /api/turn 恰一次、文本 trim、成功后清空输入框', async () => {
    input().value = '  查余额  '
    send().dispatchEvent(new Event('click'))
    await flush()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('查余额')
    expect(input().value).toBe('')
    expect(errorText()).toBeNull()
  })

  it('Enter 发送、Shift+Enter 不发送', async () => {
    input().value = '查余额'
    input().dispatchEvent(keyDown({ shiftKey: true }))
    await flush()
    expect(submit).toHaveBeenCalledTimes(0)

    input().dispatchEvent(keyDown())
    await flush()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('在飞锁：连点发送只提交一次（同一句话提交两轮 = 两次工具调用、两次审批）', async () => {
    let release
    submit.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    input().value = '转 800'

    send().dispatchEvent(new Event('click'))
    send().dispatchEvent(new Event('click'))
    release({ ok: true })
    await flush()

    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('接管期 202（queued-for-operator）⇒ 清输入但明说"不会驱动智能体"（不做假成功）', async () => {
    submit.mockResolvedValue({ ok: true, code: 'ok', message: '', accepted: 'queued-for-operator' })
    input().value = '帮我看看'

    send().dispatchEvent(new Event('click'))
    await flush()

    expect(input().value).toBe('')
    expect(errorText()).toContain('消息已记录')
    expect(errorText()).toContain('不会驱动智能体')
    expect(send().disabled).toBe(false)
  })

  it('TC-MOB-28 429(retry-after:3) ⇒ 发送钮禁用 3 秒、文案含"3 秒"、3 秒后自动恢复', async () => {
    submit.mockResolvedValue({ ok: false, code: 'turn-rate-limited', message: '太频繁', retryAfterSeconds: 3 })
    input().value = '查余额'

    send().dispatchEvent(new Event('click'))
    await flush()

    expect(send().disabled).toBe(true)
    expect(errorText()).toContain('3 秒')

    vi.advanceTimersByTime(1000)
    expect(errorText()).toContain('2 秒')
    vi.advanceTimersByTime(1000)
    expect(errorText()).toContain('1 秒')
    vi.advanceTimersByTime(1000)

    expect(send().disabled).toBe(false)
    expect(errorText()).toBeNull()
  })

  it('TC-MOB-28 429 只禁发送钮，不锁输入框（用户还能继续打字）', async () => {
    submit.mockResolvedValue({ ok: false, code: 'turn-rate-limited', message: '太频繁', retryAfterSeconds: 5 })
    input().value = '查余额'
    send().dispatchEvent(new Event('click'))
    await flush()

    expect(input().disabled).toBe(false)
    expect(stop().hidden).toBe(true)
    input().value = '还能打字'
    expect(input().value).toBe('还能打字')
  })

  it('没有可信 retry-after 时不编倒计时（缺省值由 shell 的归一化层给）', async () => {
    submit.mockResolvedValue({ ok: false, code: 'turn-rate-limited', message: '太频繁' })
    input().value = '查余额'

    composer.setSendBlocked(0)
    await flush()

    expect(send().disabled).toBe(false)
    expect(errorText()).toBe('操作太频繁，请稍后再试。')
  })

  it('TC-MOB-28 409 ⇒ 人工接管文案，输入不禁用', async () => {
    submit.mockResolvedValue({ ok: false, code: 'turn-conflict-handoff', message: '会话已交人工接管' })
    input().value = '查余额'

    send().dispatchEvent(new Event('click'))
    await flush()

    expect(errorText()).toBe('会话已交人工接管')
    expect(send().disabled).toBe(false)
    expect(input().disabled).toBe(false)
  })

  it('其它错误按 message 原样呈现，不静默', async () => {
    submit.mockResolvedValue({ ok: false, code: 'network-error', message: '网络不可达' })
    input().value = '查余额'

    send().dispatchEvent(new Event('click'))
    await flush()

    expect(errorText()).toBe('网络不可达')
  })

  it('中断钮只在确有一轮在跑时可见（常驻一个按不动的按钮是最坏的"看起来能用"）', () => {
    expect(stop().hidden).toBe(true)

    composer.setRunning(true)
    expect(stop().hidden).toBe(false)
    expect(composer.isRunning).toBe(true)

    composer.setRunning(false)
    expect(stop().hidden).toBe(true)
  })

  it('点中断 ⇒ interrupt 恰一次并如实说"已提交"，不假装"打断了一轮"', async () => {
    composer.setRunning(true)
    stop().dispatchEvent(new Event('click'))
    await flush()

    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(interrupt).toHaveBeenCalledWith('用户点击"算了"')
    expect(errorText()).toBe('中断请求已提交')
    expect(host.querySelector('[data-role="composer-error"]').classList.contains('m-composer__error--info')).toBe(true)
  })

  it('中断失败 ⇒ 错误可见', async () => {
    interrupt.mockResolvedValue({ ok: false, code: 'agent-absent', message: '没有活体 agent' })
    composer.setRunning(true)
    stop().dispatchEvent(new Event('click'))
    await flush()

    expect(errorText()).toBe('没有活体 agent')
  })

  it('自增高夹在上限内（窄屏上无限长高会把 feed 挤没）', () => {
    Object.defineProperty(input(), 'scrollHeight', { configurable: true, value: 9999 })
    input().dispatchEvent(new Event('input'))

    expect(input().style.height).toBe(`${String(MAX_INPUT_HEIGHT_PX)}px`)
    expect(MAX_INPUT_HEIGHT_PX).toBe(100)
  })

  it('setValue / focusInput 是对外接口（choice-card 的"手动输入"出口靠它）', () => {
    composer.setValue('转 500')
    expect(input().value).toBe('转 500')

    composer.focusInput()
    expect(document.activeElement).toBe(input())
  })

  it('chips 由配置注入时才渲染；点 chip 走同一条 submit 路径且不清空输入框', async () => {
    expect(host.querySelector('[data-role="chip"]')).toBeNull()
    composer.dispose()
    host.replaceChildren()

    composer = createComposer(host, {
      submit,
      interrupt,
      phrases: { items: [{ text: '转 500 给他', intent: '省略槽位' }] },
    })
    input().value = '草稿还在'
    host.querySelector('[data-role="chip"]').dispatchEvent(new Event('click'))
    await flush()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('转 500 给他')
    expect(input().value).toBe('草稿还在')
  })

  it('触控目标：发送与中断都是 button（blanket 44px 规则覆盖），且带 aria-label', () => {
    expect(send().tagName).toBe('BUTTON')
    expect(send().getAttribute('aria-label')).toBe('发送')
    expect(stop().getAttribute('aria-label')).toBe('中断本轮')
    expect(input().getAttribute('aria-label')).toBe('输入消息')
  })
})

describe('输入区 · 失败重试', () => {
  let host
  let submit
  let composer

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    submit = vi.fn(async () => ({ ok: false, code: 'network-error', message: '网络不可达' }))
    composer = createComposer(host, { submit, interrupt: vi.fn(async () => ({ ok: true })), imeDeps: { storage: undefined } })
  })

  afterEach(() => {
    composer.dispose()
    host.remove()
  })

  it('失败保留原话并出现重试钮；点重试原样再发同一条', async () => {
    const input = host.querySelector('[data-role="composer-input"]')
    input.value = '给王建国转 800 元'
    host.querySelector('[data-role="send"]').click()
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    const retry = host.querySelector('[data-role="composer-retry"]')
    expect(host.querySelector('[data-role="composer-error"]').hidden).toBe(false)
    expect(host.querySelector('[data-role="composer-error"]').textContent).toContain('网络不可达')
    expect(retry.hidden).toBe(false)
    expect(input.value).toBe('给王建国转 800 元')

    submit.mockResolvedValueOnce({ ok: true, code: 'ok', message: '' })
    retry.click()
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenLastCalledWith('给王建国转 800 元')
    expect(input.value).toBe('')
    expect(host.querySelector('[data-role="composer-error"]').hidden).toBe(true)
  })
})
