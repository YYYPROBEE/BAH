import { describe, expect, it } from 'vitest'

import {
  asKnowledgeAnswer,
  asKnowledgeHealth,
  asKnowledgeQuery,
  KNOWLEDGE_SCHEMA_VERSION,
} from './contract.ts'
import { answerResponse, healthResponse, queryResponse } from './testing.ts'

function rawAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...answerResponse(), ...overrides }
}

function rawQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...queryResponse(), ...overrides }
}

function rawHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...healthResponse(), ...overrides }
}

describe('contract guards', () => {
  it('accepts valid answer / query / health', () => {
    expect(asKnowledgeAnswer(rawAnswer()).verdict).toBe('GREEN')
    expect(asKnowledgeQuery(rawQuery()).kind).toBe('evidence')
    expect(asKnowledgeHealth(rawHealth()).status).toBe('ok')
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe('knowledge.v1')
  })

  it('rejects non-object payloads', () => {
    expect(() => asKnowledgeAnswer(null)).toThrow(/应为对象/)
    expect(() => asKnowledgeAnswer([])).toThrow(/应为对象/)
    expect(() => asKnowledgeQuery('x')).toThrow(/应为对象/)
    expect(() => asKnowledgeHealth(1)).toThrow(/应为对象/)
  })

  it('rejects schema / kind / route / status / embedding drift', () => {
    expect(() => asKnowledgeAnswer(rawAnswer({ schemaVersion: 'knowledge.v2' }))).toThrow(
      /只支持 knowledge.v1/,
    )
    expect(() => asKnowledgeAnswer(rawAnswer({ kind: 'unknown' }))).toThrow(/未知 kind/)
    expect(() => asKnowledgeQuery(rawQuery({ kind: 'unknown' }))).toThrow(/未知 kind/)
    expect(() => asKnowledgeQuery(rawQuery({ route: 'vector' }))).toThrow(/未知 route/)
    expect(() => asKnowledgeAnswer(rawAnswer({ verdict: 'MAYBE' }))).toThrow(/未知 verdict/)
    expect(() => asKnowledgeHealth(rawHealth({ status: 'down' }))).toThrow(/未知 status/)
    expect(() => asKnowledgeHealth(rawHealth({ embedding: 'maybe' }))).toThrow(
      /未知 embedding/,
    )
  })

  it('rejects wrong primitive types', () => {
    expect(() => asKnowledgeAnswer(rawAnswer({ answer: 1 }))).toThrow(/应为字符串/)
    expect(() => asKnowledgeAnswer(rawAnswer({ citations: {} }))).toThrow(/应为数组/)
    expect(() => asKnowledgeAnswer(rawAnswer({ traceId: 1 }))).toThrow(/应为字符串/)
    expect(() => asKnowledgeAnswer(rawAnswer({ reasonCode: 1 }))).toThrow(/应为字符串/)
    expect(() =>
      asKnowledgeAnswer(rawAnswer({ latencyMs: { retrieval: 'x', generation: 0, verify: 0, total: 0 } })),
    ).toThrow(/应为有限数字/)
  })

  it('rejects malformed citation and evidence entries', () => {
    expect(() =>
      asKnowledgeAnswer(
        rawAnswer({ citations: [{ ...answerResponse().citations[0], marker: 1 }] }),
      ),
    ).toThrow(/citations\[0\]\.marker/)
    expect(() =>
      asKnowledgeAnswer(
        rawAnswer({ citations: [{ ...answerResponse().citations[0], clauseNo: 1 }] }),
      ),
    ).toThrow(/clauseNo/)
    expect(() =>
      asKnowledgeAnswer(
        rawAnswer({ evidence: [{ ...answerResponse().evidence[0], tier: '1' }] }),
      ),
    ).toThrow(/evidence\[0\]\.tier/)
    expect(() =>
      asKnowledgeAnswer(
        rawAnswer({ evidence: [{ ...answerResponse().evidence[0], chunkId: '1' }] }),
      ),
    ).toThrow(/chunkId/)
  })

  it('rejects malformed candidates / values / latency', () => {
    expect(() => asKnowledgeAnswer(rawAnswer({ candidates: [{ name: 'x' }] }))).toThrow(
      /productId/,
    )
    expect(() => asKnowledgeAnswer(rawAnswer({ candidates: [{}] }))).toThrow(/productId/)
    expect(() =>
      asKnowledgeQuery(rawQuery({ values: [{ label: 'x', valueText: 1, unit: '%', cellRef: 'c' }] })),
    ).toThrow(/valueText/)
    expect(() =>
      asKnowledgeQuery(rawQuery({ values: [{ label: 'x', valueText: '1', unit: '%', cellRef: 'c', formula: 1 }] })),
    ).toThrow(/formula/)
    expect(() => asKnowledgeQuery(rawQuery({ values: [{ label: 'x' }] }))).toThrow(/valueText/)
    expect(() =>
      asKnowledgeQuery(rawQuery({ candidates: [{ productId: 'W-1' }] })),
    ).toThrow(/name/)
    expect(() => asKnowledgeAnswer(rawAnswer({ latencyMs: {} }))).toThrow(/retrieval/)
  })

  it('accepts null optional fields', () => {
    const answer = asKnowledgeAnswer(
      rawAnswer({ reasonCode: null, citations: [{ ...answerResponse().citations[0], clauseNo: null }] }),
    )
    expect(answer.reasonCode).toBeNull()
    expect(answer.citations[0]?.clauseNo).toBeNull()
  })
})
