/**
 * T-SA07-002 / 状态机守卫：字典一致、终态无出边、非法出边 fail-loud。
 */

import { describe, expect, it } from 'vitest'

import { assertTransition, isTerminal, SAGA_TRANSITIONS } from './index.ts'
import { SAGA_STATES, TERMINAL_STATES } from '../types.ts'

describe('状态机守卫', () => {
  it('终态集合与无出边不变量一致', () => {
    for (const state of SAGA_STATES) {
      expect(isTerminal(state)).toBe((TERMINAL_STATES as readonly string[]).includes(state))
      if (isTerminal(state)) expect(SAGA_TRANSITIONS[state]).toEqual([])
    }
  })

  it('合法出边放行', () => {
    expect(() => assertTransition('CREATED', 'RUNNING')).not.toThrow()
    expect(() => assertTransition('RUNNING', 'COMPENSATING')).not.toThrow()
    expect(() => assertTransition('COMPENSATING', 'COMPENSATED')).not.toThrow()
  })

  it('非法出边抛 illegal-transition', () => {
    expect(() => assertTransition('CREATED', 'SUCCEEDED')).toThrow(/illegal-transition/)
    expect(() => assertTransition('SUCCEEDED', 'RUNNING')).toThrow(/illegal-transition/)
    try {
      assertTransition('MANUALLY_CLOSED', 'RUNNING')
      expect.unreachable('终态不得有出边')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('illegal-transition')
    }
  })
})
