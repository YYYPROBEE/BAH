import { describe, expect, it } from 'vitest'

import { diffTsd, valueEquals } from '../../src/deciders/TSD.ts'

describe('TSD 终局状态差分', () => {
  // T06
  it('T06 预检代替执行（mustChange 未达）判失败', () => {
    const result = diffTsd({
      before: { 'txn.status': 'draft', 'txn.id': '' },
      after: { 'txn.status': 'pending-approval', 'txn.id': '' },
      mustChange: { 'txn.status': 'completed' },
      mustNotChange: [],
    })

    expect(result.pass).toBe(false)
    expect(result.violations).toEqual([
      {
        key: 'txn.status',
        kind: 'unmet-change',
        expected: 'completed',
        actual: 'pending-approval',
      },
    ])
    expect(result.locator).toBe('tsd:unmet-change:txn.status')
  })

  // T07
  it('T07 mustNotChange 的键被改判失败，并定位到键', () => {
    const result = diffTsd({
      before: { balance: 1000, 'txn.status': 'draft' },
      after: { balance: 900, 'txn.status': 'completed' },
      mustChange: { 'txn.status': 'completed' },
      mustNotChange: ['balance'],
    })

    expect(result.pass).toBe(false)
    expect(result.violations).toContainEqual({
      key: 'balance',
      kind: 'must-not-change',
      expected: 1000,
      actual: 900,
    })
    expect(result.locator).toBe('tsd:must-not-change:balance')
  })

  // T08
  it('T08 白名单外键发生变化判失败（多余变更）', () => {
    const result = diffTsd({
      before: { 'subs.count': 0, 'quota.used': 100, 'audit.trace': 'a' },
      after: { 'subs.count': 1, 'quota.used': 100, 'audit.trace': 'b' },
      mustChange: { 'subs.count': 1 },
      mustNotChange: ['quota.used'],
    })

    expect(result.pass).toBe(false)
    // 未声明的变更最隐蔽：模型既没被要求也没被禁止，但它让状态漂了，必须 fail。
    expect(result.violations).toEqual([
      { key: 'audit.trace', kind: 'undeclared-change', expected: 'a', actual: 'b' },
    ])
    expect(result.locator).toBe('tsd:undeclared-change:audit.trace')
  })

  it('白名单外新增键同样判失败', () => {
    const result = diffTsd({
      before: { a: 1 },
      after: { a: 1, 'steps.s2.state': 'reserved' },
      mustChange: { a: 1 },
      mustNotChange: [],
    })
    expect(result.pass).toBe(false)
    expect(result.violations[0]?.key).toBe('steps.s2.state')
  })

  it('全部符合期望时判通过', () => {
    const result = diffTsd({
      before: { 'txn.status': 'draft', balance: 1000 },
      after: { 'txn.status': 'completed', balance: 1000 },
      mustChange: { 'txn.status': 'completed' },
      mustNotChange: ['balance'],
    })
    expect(result.pass).toBe(true)
    expect(result.violations).toHaveLength(0)
    expect(result.locator).toBeUndefined()
  })
})

describe('TSD 值比较口径', () => {
  it('数组按等价集合比较（顺序无关）', () => {
    expect(valueEquals(['a', 'b'], ['b', 'a'])).toBe(true)
  })

  it('数组长度不同即不等', () => {
    expect(valueEquals(['a', 'b'], ['a'])).toBe(false)
  })

  it('数组元素重复按重数比较', () => {
    expect(valueEquals(['a', 'a'], ['a', 'b'])).toBe(false)
  })

  it('对象深比较闭包', () => {
    expect(valueEquals({ a: { b: [1, 2] } }, { a: { b: [2, 1] } })).toBe(true)
    expect(valueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it('对象与数组互不相等', () => {
    expect(valueEquals({ a: 1 }, [1])).toBe(false)
    expect(valueEquals([1], { 0: 1 })).toBe(false)
  })

  it('数值按 Object.is 比较（NaN 与 -0 的语义）', () => {
    expect(valueEquals(Number.NaN, Number.NaN)).toBe(true)
    expect(valueEquals(-0, 0)).toBe(false)
  })
})
