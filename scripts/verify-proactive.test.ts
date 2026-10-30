import { describe, expect, it } from 'vitest'

import {
  checkDigests,
  checkForbiddenSources,
  checkIdempotency,
  checkNoLlm,
  checkTicketWitness,
} from './verify-proactive.ts'

describe('verify-proactive（反例自测：坏样本必须红）', () => {
  it('I13：没有带 inputs 的判决 ⇒ 红（没扫到 ≠ 通过）', () => {
    expect(checkDigests([]).join('\n')).toContain('I13')
  })

  it('I13：digest 与 inputs 不一致 ⇒ 红', () => {
    const findings = checkDigests([{ status: 'executed', digest: 'deadbeef', inputs: { balanceCents: 1 } }])
    expect(findings.join('\n')).toContain('I13')
  })

  it('I13：执行成功的 digest 不在票据里 ⇒ 红', () => {
    expect(checkTicketWitness([{ digest: 'abc' }], []).join('\n')).toContain('I13')
    expect(checkTicketWitness([{ digest: 'abc' }], ['abc'])).toEqual([])
  })

  it('I15：重复执行 / 缺 already-ran ⇒ 红', () => {
    expect(checkIdempotency([], 2).join('\n')).toContain('I15')
    expect(checkIdempotency([{ status: 'skipped', reason: 'dry-run' }], 1).join('\n')).toContain('I15')
    expect(checkIdempotency([{ status: 'skipped', reason: 'already-ran' }], 1)).toEqual([])
  })

  it('I16：五禁逐条能红', () => {
    for (const source of [
      'const now = Date.now()',
      'const r = Math.random()',
      'session.appendDomain("x", {})',
      'store.append(event)',
      'setTimeout(run, 1)',
    ]) {
      expect(checkForbiddenSources({ 'pure.ts': source }).join('\n')).toContain('I16')
    }
    expect(checkForbiddenSources({ 'pure.ts': 'export const add = (a: number, b: number) => a + b' })).toEqual([])
  })

  it('I17：唤醒链 import LLM ⇒ 红', () => {
    expect(checkNoLlm({ 'wake.ts': "import { x } from '@bah/llm'" }).join('\n')).toContain('I17')
    expect(checkNoLlm({ 'wake.ts': "import { y } from '@bah/runtime'" })).toEqual([])
  })
})
