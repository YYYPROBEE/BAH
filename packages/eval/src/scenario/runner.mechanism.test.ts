/**
 * TC-W13-04 / 05：超时与失败原因码（不 boot，直接测机制）。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { SCENARIO_TIMEOUT_MS, classifyEvalFailure, evaluateExpectations, runWithTimeout } from './runner.ts'

describe('W13 · 失败机制', () => {
  it('TC-W13-04 单场景 5s 超时 → scenario-timeout', async () => {
    expect(SCENARIO_TIMEOUT_MS).toBe(5_000)
    const never = new Promise<never>(() => undefined)
    try {
      await runWithTimeout(never, 5)
      throw new Error('应当超时')
    } catch (error) {
      expect(classifyEvalFailure(error).code).toBe('scenario-timeout')
    }
  })

  it('TC-W13-05 失败原因码：upstream-unavailable / tool-error / assertion-failed 都可表达', () => {
    expect(classifyEvalFailure(new BahError('upstream-unavailable', '外部不可用')).code).toBe(
      'upstream-unavailable',
    )
    expect(classifyEvalFailure(new BahError('saga-step-failed', '编排失败')).code).toBe('tool-error')

    const violation = evaluateExpectations(
      [{ kind: 'tool-sequence', tools: ['transfer_create'], mode: 'exact' }],
      [],
      [],
    )
    expect(violation).toContain('tool-sequence')
  })
})
