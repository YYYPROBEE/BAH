import { describe, expect, it } from 'vitest'

import { isNearBottom, scrollToBottom, STICK_THRESHOLD_PX } from './scroll.js'

describe('scroll · 贴底判定', () => {
  it('内容不足一屏 / 空节点一律视为在底部', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true)
    expect(isNearBottom(null)).toBe(true)
    expect(isNearBottom(undefined)).toBe(true)
  })

  it('距底部超过阈值算离开底部，阈值内继续跟随', () => {
    const at = (top) => ({ scrollTop: top, scrollHeight: 1000, clientHeight: 400 })
    expect(isNearBottom(at(600))).toBe(true)
    expect(isNearBottom(at(600 - STICK_THRESHOLD_PX + 1))).toBe(true)
    expect(isNearBottom(at(500))).toBe(false)
  })

  it('滚到底写 scrollTop = scrollHeight', () => {
    const node = { scrollTop: 0, scrollHeight: 1200 }
    scrollToBottom(node)
    expect(node.scrollTop).toBe(1200)
    expect(() => scrollToBottom(null)).not.toThrow()
  })

  it('程序化贴底临时关掉 CSS smooth，滚完恢复原样', () => {
    const node = document.createElement('div')
    node.style.scrollBehavior = 'smooth'
    Object.defineProperty(node, 'scrollHeight', { configurable: true, value: 500 })
    Object.defineProperty(node, 'scrollTop', { configurable: true, writable: true, value: 0 })
    scrollToBottom(node)
    expect(node.scrollTop).toBe(500)
    expect(node.style.scrollBehavior).toBe('smooth')
  })

  it('阈值可注入（不同端可用不同手感）', () => {
    const node = { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }
    expect(isNearBottom(node, 80)).toBe(false)
    expect(isNearBottom(node, 120)).toBe(true)
  })
})
