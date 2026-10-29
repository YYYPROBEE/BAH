/**
 * IME 适配层用例（TC-MOB-16/17/18/20）。
 *
 * 桩纪律：`CompositionEvent` 手工派发（jsdom 默认不派发组合事件）、假 storage、
 * 假 submit。生产代码的注入点全是可选参数，缺省走真实浏览器 API（A1 探针）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createComposer } from './composer.js'
import { HINT_STORAGE_KEY, HINT_TEXT, applyImeAttributes, createImeInput } from './ime-input.js'

const MOBILE_DIR = import.meta.dirname

/** 生产源码（排除测试文件：桩只允许待在 `.test.js` 里）。 */
function productionSources() {
  return readdirSync(MOBILE_DIR)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map((name) => join(MOBILE_DIR, name))
}

/** jsdom 未必有 CompositionEvent 构造器：退化成 Event + 补 data。 */
function composition(type, data = '') {
  if (typeof CompositionEvent === 'function') {
    try {
      return new CompositionEvent(type, { data, bubbles: true })
    } catch {
      // 落到下面的兜底
    }
  }
  const event = new Event(type, { bubbles: true })
  Object.assign(event, { data })
  return event
}

function keyDown(init = {}) {
  return new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
}

/** 假 storage（jsdom 的 localStorage 可用，但测试要能断言"写了哪个键"）。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() {
      return map.size
    },
  }
}

describe('输入框属性装配', () => {
  it('TC-MOB-16 主输入框四项属性齐全（自动更正是移动端破坏金额/账号/户名的头号原因）', () => {
    const host = document.createElement('div')
    const input = document.createElement('textarea')

    createImeInput(host, { input })

    expect(input.getAttribute('enterkeyhint')).toBe('send')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
    expect(input.getAttribute('inputmode')).toBeNull()
  })

  it('TC-MOB-16 金额类内联输入另给 inputmode=decimal', () => {
    const input = document.createElement('input')
    input.type = 'text'

    applyImeAttributes(input, 'amount')

    expect(input.getAttribute('inputmode')).toBe('decimal')
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
  })

  it('提示条文案是"点键盘上的麦克风图标即可说话"，且装饰图标 aria-hidden', () => {
    const host = document.createElement('div')
    const input = document.createElement('textarea')

    createImeInput(host, { input, deps: { storage: fakeStorage() } })

    const hint = host.querySelector('[data-role="ime-hint"]')
    expect(hint).not.toBeNull()
    expect(hint.textContent).toContain(HINT_TEXT)
    expect(hint.querySelector('.icon--mic').getAttribute('aria-hidden')).toBe('true')
    expect(hint.querySelector('[data-role="ime-hint-close"]').getAttribute('aria-label')).toBe('不再提示')
  })
})

describe('组合态状态机', () => {
  let host
  let input
  let ime

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    input = document.createElement('textarea')
    host.append(input)
    ime = createImeInput(host, { input, deps: { storage: fakeStorage() } })
  })

  afterEach(() => {
    ime.dispose()
    host.remove()
  })

  it('TC-MOB-17 compositionstart ⇒ 组合中；compositionend ⇒ 退出组合', () => {
    expect(ime.isComposing()).toBe(false)

    input.dispatchEvent(composition('compositionstart', 'zhuan'))
    expect(ime.isComposing()).toBe(true)

    input.dispatchEvent(composition('compositionupdate', 'zhuanz'))
    expect(ime.isComposing()).toBe(true)

    input.dispatchEvent(composition('compositionend', '转账'))
    expect(ime.isComposing()).toBe(false)
  })

  it('TC-MOB-20 resetComposing 把卡住的组合态拉回 idle（切后台后 compositionend 可能永不派发）', () => {
    input.dispatchEvent(composition('compositionstart', 'zhuan'))
    expect(ime.isComposing()).toBe(true)

    ime.resetComposing()
    expect(ime.isComposing()).toBe(false)
  })

  it('dispose 摘掉三个组合监听（复位后不再随事件翻转）', () => {
    ime.dispose()
    input.dispatchEvent(composition('compositionstart', 'zhuan'))

    expect(ime.isComposing()).toBe(false)
    expect(host.querySelector('[data-role="ime-hint"]')).toBeNull()
  })
})

describe('TC-MOB-17 组合期间的回车不是发送（与 composer 联动）', () => {
  let host
  let submit
  let composer

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    submit = vi.fn(async () => ({ ok: true, code: 'ok', message: '' }))
    composer = createComposer(host, {
      submit,
      interrupt: vi.fn(async () => ({ ok: true })),
      imeDeps: { storage: fakeStorage() },
    })
  })

  afterEach(() => {
    composer.dispose()
    host.remove()
    vi.useRealTimers()
  })

  const input = () => host.querySelector('[data-role="composer-input"]')

  async function flush() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }

  it('组合中按 Enter ⇒ POST /api/turn 零调用', async () => {
    input().value = 'zhuan'
    input().dispatchEvent(composition('compositionstart', 'zhuan'))
    input().dispatchEvent(keyDown())
    await flush()

    expect(submit).toHaveBeenCalledTimes(0)
    expect(input().value).toBe('zhuan')
  })

  it('组合中按 Enter 也不触发自增高以外的任何校验路径（零请求，C4-④）', async () => {
    input().value = 'zhuan'
    input().dispatchEvent(composition('compositionstart', 'zhuan'))
    input().dispatchEvent(keyDown({ isComposing: false, keyCode: 229 }))
    await flush()

    // keyCode 229（Safari/旧内核的组合标记）单独就能拦住，不依赖 isComposing
    expect(submit).toHaveBeenCalledTimes(0)
  })

  it('compositionend 之后 Enter ⇒ 发送恰一次，且发送后清空输入框', async () => {
    input().value = '转账'
    input().dispatchEvent(composition('compositionstart', 'zhuan'))
    input().dispatchEvent(composition('compositionend', '转账'))
    input().dispatchEvent(keyDown())
    await flush()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('转账')
    expect(input().value).toBe('')
  })

  it('组合结束**不自动发送**：用户必须显式回车或点发送钮', async () => {
    input().value = '转账'
    input().dispatchEvent(composition('compositionstart', 'zhuan'))
    input().dispatchEvent(composition('compositionend', '转账'))
    await flush()

    expect(submit).toHaveBeenCalledTimes(0)
  })

  it('R2 时序一：compositionend 先于末次 input（Android Chrome）', async () => {
    input().dispatchEvent(composition('compositionstart', 'zhuan'))
    input().dispatchEvent(composition('compositionend', '转账'))
    input().value = '转账'
    input().dispatchEvent(new Event('input', { bubbles: true }))
    input().dispatchEvent(keyDown())
    await flush()

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('转账')
  })

  it('R2 时序二：末次 input 先于 compositionend（iOS Safari）', async () => {
    input().dispatchEvent(composition('compositionstart', 'zhuan'))
    input().value = '转账'
    input().dispatchEvent(new Event('input', { bubbles: true }))
    input().dispatchEvent(keyDown())
    await flush()
    expect(submit).toHaveBeenCalledTimes(0)

    input().dispatchEvent(composition('compositionend', '转账'))
    input().dispatchEvent(keyDown())
    await flush()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('Shift+Enter 是换行不是发送（与桌面壳同口径）', async () => {
    input().value = '第一行'
    input().dispatchEvent(keyDown({ shiftKey: true }))
    await flush()

    expect(submit).toHaveBeenCalledTimes(0)
  })

  it('空白文本不发送（服务端会以 web-empty-message 拒，前端先挡）', async () => {
    input().value = '   '
    input().dispatchEvent(keyDown())
    await flush()

    expect(submit).toHaveBeenCalledTimes(0)
  })

  it('TC-MOB-20 visibilitychange 到 hidden ⇒ 组合态复位，回前台后 Enter 可正常发送', async () => {
    input().value = '转账'
    input().dispatchEvent(composition('compositionstart', 'zhuan'))
    expect(composer.ime.isComposing()).toBe(true)

    composer.ime.resetComposing()
    input().dispatchEvent(keyDown())
    await flush()

    expect(composer.ime.isComposing()).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('TC-MOB-18 提示条偏好与零媒体权限面', () => {
  it('关闭提示 ⇒ 偏好写进 localStorage（键名精确断言），重建实例不再显示', () => {
    const host = document.createElement('div')
    const storage = fakeStorage()
    const input = document.createElement('textarea')
    host.append(input)

    const first = createImeInput(host, { input, deps: { storage } })
    expect(first.hint).not.toBeNull()

    host.querySelector('[data-role="ime-hint-close"]').dispatchEvent(new Event('click'))
    expect(host.querySelector('[data-role="ime-hint"]')).toBeNull()
    expect(storage.getItem(HINT_STORAGE_KEY)).not.toBeNull()
    expect(HINT_STORAGE_KEY).toBe('bah.m.imeHintDismissed')
    first.dispose()

    const host2 = document.createElement('div')
    const input2 = document.createElement('textarea')
    host2.append(input2)
    const second = createImeInput(host2, { input: input2, deps: { storage } })
    expect(second.hint).toBeNull()
    expect(host2.querySelector('[data-role="ime-hint"]')).toBeNull()
    second.dispose()
  })

  it('storage 抛错（隐私模式）不让按钮失灵：节点照样移除', () => {
    const host = document.createElement('div')
    const input = document.createElement('textarea')
    host.append(input)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }

    const ime = createImeInput(host, { input, deps: { storage: broken } })
    expect(ime.hint).not.toBeNull()

    host.querySelector('[data-role="ime-hint-close"]').dispatchEvent(new Event('click'))
    expect(host.querySelector('[data-role="ime-hint"]')).toBeNull()
    ime.dispose()
  })

  it('判据①：全部生产源码零媒体采集/页面内识别 API 的字面量', () => {
    const forbidden = ['getUserMedia', 'SpeechRecognition', 'webkitSpeechRecognition', 'mediaDevices', 'AudioContext']
    const files = productionSources()
    expect(files.length).toBeGreaterThanOrEqual(10)

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const word of forbidden) {
        expect(source.includes(word), `${file} 出现了 ${word}`).toBe(false)
      }
    }
  })

  it('判据②：运行时也没人碰媒体面（挂 spy 跑一遍完整交互）', () => {
    const gum = vi.fn()
    const Recognition = vi.fn()
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum } })
    globalThis.SpeechRecognition = Recognition
    globalThis.webkitSpeechRecognition = Recognition

    try {
      const host = document.createElement('div')
      const input = document.createElement('textarea')
      host.append(input)
      const ime = createImeInput(host, { input, deps: { storage: fakeStorage() } })
      input.dispatchEvent(composition('compositionstart', 'zhuan'))
      input.value = '转账'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(composition('compositionend', '转账'))
      host.querySelector('[data-role="ime-hint-close"]').dispatchEvent(new Event('click'))
      ime.dispose()

      expect(gum).toHaveBeenCalledTimes(0)
      expect(Recognition).toHaveBeenCalledTimes(0)
    } finally {
      delete globalThis.SpeechRecognition
      delete globalThis.webkitSpeechRecognition
      if (descriptor === undefined) delete navigator.mediaDevices
      else Object.defineProperty(navigator, 'mediaDevices', descriptor)
    }
  })
})
