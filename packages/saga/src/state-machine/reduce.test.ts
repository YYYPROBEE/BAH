/**
 * T-SA08-001 + 唯一转移函数 `reduceSaga` 的语义。
 */

import { describe, expect, it } from 'vitest'

import { initialProjection, reduceSaga, SAGA_TRANSITIONS } from './index.ts'
import { assertTransition, isTerminal } from './index.ts'
import { SAGA_STATES, TERMINAL_STATES } from '../types.ts'

import type { SagaEventRecord, SagaProjection } from '../types.ts'

/** SA-00 §4.1 冻结字典（双向包含校验）。 */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  CREATED: ['RUNNING'],
  RUNNING: ['SUCCEEDED', 'ABORTED_CLEAN', 'COMPENSATING', 'PENDING_RISK_REVIEW', 'GATE_HOLDING', 'COMPENSATION_DLQ'],
  PENDING_RISK_REVIEW: ['RUNNING', 'COMPENSATING', 'ABORTED_CLEAN'],
  GATE_HOLDING: ['RUNNING', 'COMPENSATING'],
  COMPENSATING: ['COMPENSATED', 'PARTIALLY_COMPENSATED', 'COMPENSATION_DLQ', 'MANUALLY_CLOSED'],
  PARTIALLY_COMPENSATED: ['COMPENSATING', 'MANUALLY_CLOSED'],
  COMPENSATION_DLQ: ['MANUALLY_CLOSED'],
  SUCCEEDED: [],
  ABORTED_CLEAN: [],
  COMPENSATED: [],
  MANUALLY_CLOSED: [],
}

function event(type: string, subjectRef = '', sagaId = 's1'): SagaEventRecord {
  return { sagaId, seqInSaga: 1, type, subjectRef, happensBefore: [], payloadDigest: 'digest' }
}

function fold(events: readonly SagaEventRecord[]): SagaProjection {
  return events.reduce(reduceSaga, initialProjection('s1'))
}

describe('T-SA08-001 状态转换表全量', () => {
  it('11 态出边双向一致，终态无出边', () => {
    expect(Object.keys(SAGA_TRANSITIONS).sort()).toEqual([...SAGA_STATES].sort())
    for (const from of SAGA_STATES) {
      const actual = SAGA_TRANSITIONS[from]
      const expected = EXPECTED[from] ?? []
      expect([...actual].sort()).toEqual([...expected].sort())
      expect(isTerminal(from)).toBe((TERMINAL_STATES as readonly string[]).includes(from))
      if (isTerminal(from)) expect(actual).toEqual([])
    }
  })

  it('任一非法对抛 illegal-transition', () => {
    for (const from of SAGA_STATES) {
      for (const to of SAGA_STATES) {
        if (SAGA_TRANSITIONS[from].includes(to)) continue
        expect(() => assertTransition(from, to)).toThrow(/illegal-transition/)
      }
    }
  })
})

describe('reduceSaga 唯一转移函数', () => {
  it('saga/created 从 CREATED 推到 RUNNING；重复 created 不回头', () => {
    const running = fold([event('saga/created')])
    expect(running.state).toBe('RUNNING')
    expect(fold([event('saga/created'), event('saga/created')]).state).toBe('RUNNING')
  })

  it('step-planned 登记步骤；全部 call-result 后推断 SUCCEEDED', () => {
    const settled = fold([
      event('saga/created'),
      event('saga/step-planned', 'step-1'),
      event('saga/step-planned', 'step-2'),
      event('saga/call-result', 'step-1'),
    ])
    expect(settled.state).toBe('RUNNING')
    expect(settled.steps).toEqual({ 'step-1': 'EXECUTED', 'step-2': 'PLANNED' })

    const done = fold([
      event('saga/created'),
      event('saga/step-planned', 'step-1'),
      event('saga/call-result', 'step-1'),
    ])
    expect(done.state).toBe('SUCCEEDED')
    expect(done.steps['step-1']).toBe('EXECUTED')
  })

  it('comp-decided / dlq / manually-closed 分别进入对应状态', () => {
    expect(fold([event('saga/created'), event('saga/comp-decided', 'step-1')]).state).toBe('COMPENSATING')
    expect(fold([event('saga/created'), event('saga/dlq-escalated', 'dlq-1')]).state).toBe('COMPENSATION_DLQ')
    expect(fold([event('saga/created'), event('saga/manually-closed')]).state).toBe('MANUALLY_CLOSED')
  })

  it('unknown-probe / recovered 只改进度视图；未知事件原样返回', () => {
    const probed = fold([
      event('saga/created'),
      event('saga/step-planned', 'step-1'),
      event('saga/unknown-probe', 'step-1'),
    ])
    expect(probed.steps['step-1']).toBe('PROBING')
    expect(probed.state).toBe('RUNNING')

    const recovered = fold([
      event('saga/created'),
      event('saga/step-planned', 'step-1'),
      event('saga/recovered', 'step-1#skip-executed'),
    ])
    expect(recovered.steps['step-1']).toBe('EXECUTED')

    const probedRecovered = fold([
      event('saga/created'),
      event('saga/step-planned', 'step-1'),
      event('saga/recovered', 'step-1#probe'),
    ])
    expect(probedRecovered.steps['step-1']).toBe('PROBING')

    const dlqRecovered = fold([
      event('saga/created'),
      event('saga/step-planned', 'step-1'),
      event('saga/recovered', 'step-1#dlq'),
    ])
    expect(dlqRecovered.steps['step-1']).toBe('UNRESOLVED')

    // 未知恢复动作必须 fail-loud（回放遇到新动作不能静默停在 PLANNED）
    expect(() =>
      fold([
        event('saga/created'),
        event('saga/step-planned', 'step-1'),
        event('saga/recovered', 'step-1#future-action'),
      ]),
    ).toThrow(/saga-unreduced-recovery/)

    const before = fold([event('saga/created')])
    expect(reduceSaga(before, event('saga/tick'))).toEqual(before)
    // 白名单之外的未知事件必须 fail-loud：新状态事件漏接不能悄悄不推进
    expect(() => reduceSaga(before, event('saga/future-state-event'))).toThrow(
      /saga-unreduced-event/,
    )
  })

  it('事件与投影 sagaId 不一致即 fail-loud', () => {
    expect(() => reduceSaga(initialProjection('s1'), event('saga/created', '', 's2'))).toThrow(/saga-mismatch/)
  })
})
