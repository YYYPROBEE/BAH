/**
 * 坐席凭证闸（B2）：sessionStorage 失效时的内存兜底是重点。
 */

import { describe, expect, it } from 'vitest'

import { createGate, OPERATOR_TOKEN_KEY } from './gate.js'

/** 可控的内存 storage（可模拟抛 SecurityError）。 */
function memoryStorage(options = {}) {
  const map = new Map()
  return {
    map,
    getItem(key) {
      if (options.throwOnGet === true) throw new Error('SecurityError')
      return map.get(key) ?? null
    },
    setItem(key, value) {
      if (options.throwOnSet === true) throw new Error('SecurityError')
      map.set(key, String(value))
    },
    removeItem(key) {
      if (options.throwOnRemove === true) throw new Error('SecurityError')
      map.delete(key)
    },
  }
}

describe('gate · sessionStorage', () => {
  it('无 token → 空串；保存后可读；清空后为空', () => {
    const storage = memoryStorage()
    const gate = createGate(storage)
    expect(gate.readToken()).toBe('')
    expect(gate.saveToken('op-1')).toBe(true)
    expect(storage.map.get(OPERATOR_TOKEN_KEY)).toBe('op-1')
    expect(gate.readToken()).toBe('op-1')
    gate.clearToken()
    expect(gate.readToken()).toBe('')
    expect(storage.map.has(OPERATOR_TOKEN_KEY)).toBe(false)
  })

  it('setItem 抛错 → 返回 false，但内存仍记得（不会陷入重输死循环）', () => {
    const gate = createGate(memoryStorage({ throwOnSet: true }))
    expect(gate.saveToken('op-2')).toBe(false)
    expect(gate.readToken()).toBe('op-2')
    expect(gate.storageBroken()).toBe(true)
  })

  it('getItem 抛错 → 回内存兜底', () => {
    const gate = createGate(memoryStorage({ throwOnGet: true }))
    expect(gate.readToken()).toBe('')
    expect(gate.storageBroken()).toBe(true)
  })

  it('没有 sessionStorage（非浏览器）→ 只用内存', () => {
    const gate = createGate(null)
    expect(gate.saveToken('op-3')).toBe(false)
    expect(gate.readToken()).toBe('op-3')
    gate.clearToken()
    expect(gate.readToken()).toBe('')
  })
})
