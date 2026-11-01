import { describe, expect, it, vi } from 'vitest'

import {
  FONT_ATTR,
  PREF_KEYS,
  applyFontScale,
  createFeedbackStore,
  createPrefs,
  feedbackKeyOf,
  isLargeFont,
} from './prefs.js'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

describe('prefs · 读写', () => {
  it('缺省值与 JSON 损坏都退回安全默认，不抛', () => {
    const storage = memoryStorage({ bad: '{not-json', scalar: '3' })
    const prefs = createPrefs(storage)
    expect(prefs.get('missing')).toBe(null)
    expect(prefs.getJson('bad', {})).toEqual({})
    expect(prefs.getJson('scalar', {})).toEqual({})
    expect(prefs.getJson('missing', { a: 1 })).toEqual({ a: 1 })
  })

  it('存储抛错时读写都不影响页面', () => {
    const throwing = {
      getItem: vi.fn(() => {
        throw new Error('denied')
      }),
      setItem: vi.fn(() => {
        throw new Error('denied')
      }),
      removeItem: vi.fn(() => {
        throw new Error('denied')
      }),
    }
    const prefs = createPrefs(throwing)
    expect(prefs.get('x')).toBe(null)
    expect(() => prefs.set('x', '1')).not.toThrow()
    expect(() => prefs.remove('x')).not.toThrow()
    expect(() => prefs.setJson('x', { a: 1 })).not.toThrow()
  })

  it('大字模式写根属性并可撤销', () => {
    document.documentElement.removeAttribute(FONT_ATTR)
    applyFontScale(document, 'large')
    expect(document.documentElement.getAttribute(FONT_ATTR)).toBe('large')
    applyFontScale(document, 'normal')
    expect(document.documentElement.hasAttribute(FONT_ATTR)).toBe(false)
  })

  it('isLargeFont 只认存储里的 large', () => {
    expect(isLargeFont(createPrefs(memoryStorage({ [PREF_KEYS.fontScale]: 'large' })))).toBe(true)
    expect(isLargeFont(createPrefs(memoryStorage()))).toBe(false)
  })
})

describe('prefs · 反馈', () => {
  it('同一结论再点一次 = 取消；不同结论互相覆盖', () => {
    const prefs = createPrefs(memoryStorage())
    const store = createFeedbackStore(prefs)
    expect(store.rate('s:1', 'up')).toBe('up')
    expect(store.get('s:1')).toBe('up')
    expect(store.rate('s:1', 'up')).toBe(null)
    expect(store.get('s:1')).toBe(null)
    expect(store.rate('s:1', 'down')).toBe('down')
    expect(store.get('s:1')).toBe('down')
  })

  it('超过上限按写入顺序淘汰，旧键不再返回', () => {
    const prefs = createPrefs(memoryStorage())
    const store = createFeedbackStore(prefs, 2)
    store.rate('a', 'up')
    store.rate('b', 'up')
    store.rate('c', 'up')
    expect(store.get('a')).toBe(null)
    expect(store.get('b')).toBe('up')
    expect(store.get('c')).toBe('up')
  })

  it('反馈键带会话号；会话缺失时用 local', () => {
    expect(feedbackKeyOf('s-1', 3)).toBe('s-1:3')
    expect(feedbackKeyOf(null, 3)).toBe('local:3')
    expect(feedbackKeyOf('', 3)).toBe('local:3')
  })
})
