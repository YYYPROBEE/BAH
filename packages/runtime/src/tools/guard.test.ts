/**
 * 单调 guard 与参数指纹单测（施工单 03 §2.3 第 ④ 段）。
 */

import { describe, expect, it } from 'vitest'

import { ToolGuard, fingerprintOf } from './guard.ts'

describe('fingerprintOf', () => {
  it('同名同参（键序不同）得到同一指纹', () => {
    const left = fingerprintOf({ callId: 'c1', name: 'bank:transfer', args: { a: 1, b: 2 } })
    const right = fingerprintOf({ callId: 'c9', name: 'bank:transfer', args: { b: 2, a: 1 } })

    expect(left).toBe(right)
    expect(left).toBe('bank:transfer:{"a":1,"b":2}')
  })

  it('参数变化即指纹变化（票据绑定与 guard 都靠它）', () => {
    const small = fingerprintOf({ callId: 'c1', name: 'bank:transfer', args: { amount: 1 } })
    const big = fingerprintOf({ callId: 'c1', name: 'bank:transfer', args: { amount: 2 } })

    expect(small).not.toBe(big)
  })

  it('覆盖数组 / null / 嵌套对象', () => {
    expect(fingerprintOf({ callId: 'c', name: 't', args: { list: [1, { b: 2, a: null }] } })).toBe(
      't:{"list":[1,{"a":null,"b":2}]}',
    )
  })
})

describe('ToolGuard', () => {
  it('记录 deny 后可查到；reset 清空（turn 边界）', () => {
    const guard = new ToolGuard()
    const verdict = { kind: 'deny' as const, reason: '规则拦截', code: 'dangerous-op' }

    expect(guard.check('fp')).toBeUndefined()
    guard.deny('fp', verdict)

    expect(guard.check('fp')).toEqual(verdict)
    expect(guard.size).toBe(1)

    guard.reset()
    expect(guard.size).toBe(0)
    expect(guard.check('fp')).toBeUndefined()
  })
})
