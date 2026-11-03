import { describe, expect, it } from 'vitest'

import { deepClone } from '../src/deep-clone.ts'
import { isPlainObject } from '../src/plain-object.ts'

describe('isPlainObject：按原型判，不按 typeof 判', () => {
  it('普通对象与 Object.create(null) 算普通对象', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null) as object)).toBe(true)
  })

  it('Date / Map / 类实例不算普通对象（typeof 同样是 object，按它判会吃成 {}）', () => {
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
    expect(isPlainObject(new (class Widget {})())).toBe(false)
  })

  it('数组、null、基本类型都不算', () => {
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })
})

describe('deepClone：只深拷 JSON 面数据', () => {
  it('嵌套对象与数组全部断开引用', () => {
    const source = { a: { b: [1, { c: 2 }] } }
    const clone = deepClone(source)

    expect(clone).toEqual(source)
    expect(clone.a).not.toBe(source.a)
    expect(clone.a.b).not.toBe(source.a.b)
    expect(clone.a.b[1]).not.toBe(source.a.b[1])
  })

  it('改副本不影响原件（这正是快照要的语义）', () => {
    const source = { list: [1, 2] }
    const clone = deepClone(source)
    clone.list.push(3)

    expect(source.list).toEqual([1, 2])
    expect(clone.list).toEqual([1, 2, 3])
  })

  it('Date 复制成新实例而非原引用（且不被吃成 {}）', () => {
    const date = new Date('2026-10-22T00:00:00.000Z')
    const clone = deepClone(date)

    expect(clone).toBeInstanceOf(Date)
    expect(clone).not.toBe(date)
    expect(clone.getTime()).toBe(date.getTime())
  })

  it('不可预测的值原样保留（不为了深拷引入抛错点）', () => {
    const fn = (): number => 1
    const instance = new (class Widget {
      readonly x = 1
    })()
    const clone = deepClone({ fn, instance })

    expect(clone.fn).toBe(fn)
    expect(clone.instance).toBe(instance)
  })

  it('基本类型直接返回', () => {
    expect(deepClone(1)).toBe(1)
    expect(deepClone('x')).toBe('x')
    expect(deepClone(null)).toBe(null)
  })
})
