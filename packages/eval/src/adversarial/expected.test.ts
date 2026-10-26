/**
 * TC-W14-01 / 07 / 08：对抗集静态契约。
 */

import { describe, expect, it } from 'vitest'

import { ADVERSARIAL_SCENARIOS, ADVERSARIAL_META, familyLabel, validateAdversarial } from './index.ts'

describe('W14 · 对抗集静态契约', () => {
  it('TC-W14-01 45 例齐全，三族各 15，ID 唯一，每例有期望与依据', () => {
    const result = validateAdversarial(ADVERSARIAL_SCENARIOS)
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
    expect(ADVERSARIAL_SCENARIOS).toHaveLength(45)
    for (const family of ['I', 'P', 'H'] as const) {
      expect(ADVERSARIAL_META.filter((meta) => meta.family === family)).toHaveLength(15)
    }
    expect(new Set(ADVERSARIAL_META.map((meta) => meta.id)).size).toBe(45)
    for (const meta of ADVERSARIAL_META) {
      expect(meta.input.trim().length).toBeGreaterThan(0)
      expect(meta.rationale.trim().length).toBeGreaterThan(0)
    }
    expect(familyLabel('I')).toBe('注入')
    expect(familyLabel('P')).toBe('越权')
    expect(familyLabel('H')).toBe('幻觉')
  })

  it('TC-W14-07 外部来源必须有 URL/编号；[unverified] 只允许外部来源', () => {
    const external = ADVERSARIAL_META.filter((meta) => meta.source.kind === 'external')
    expect(external.length).toBeGreaterThanOrEqual(10)
    for (const meta of external) {
      if (meta.source.verified) expect((meta.source.ref ?? '').length).toBeGreaterThan(0)
    }
    const unverified = ADVERSARIAL_META.filter((meta) => !meta.source.verified)
    expect(unverified).toHaveLength(1)
    expect(unverified[0]?.source.kind).toBe('external')
  })

  it('TC-W14-08 越权族每一例都断言了“余额未变”', () => {
    const privilege = ADVERSARIAL_SCENARIOS.filter((scenario) => scenario.spec.id.startsWith('P-'))
    expect(privilege).toHaveLength(15)
    for (const scenario of privilege) {
      expect(
        scenario.spec.expect.some(
          (expectation) =>
            expectation.kind === 'tool-result' &&
            expectation.tool === 'account_balance' &&
            expectation.path === 'balanceCents',
        ),
      ).toBe(true)
    }
  })
})
