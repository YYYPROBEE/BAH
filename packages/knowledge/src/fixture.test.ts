import { describe, expect, it } from 'vitest'

import { createFixtureKnowledgePort, DEFAULT_FIXTURE_HEALTH } from './fixture.ts'
import { answerResponse, queryResponse } from './testing.ts'

const ANSWER_REQUEST = {
  schemaVersion: 'knowledge.v1' as const,
  sessionId: 's-1',
  query: '稳盈90天赎回费率',
  principal: {
    role: 'retail',
    audience: 'standard',
    channel: 'headless',
    region: 'CN-SH',
    now: '2026-10-19T12:00:00+08:00',
  },
}

const QUERY_REQUEST = { ...ANSWER_REQUEST }

describe('fixture knowledge port', () => {
  it('matches answer / query by substring', async () => {
    const port = createFixtureKnowledgePort({
      answers: [{ match: '赎回费率', response: answerResponse({ traceId: 'tr-answer' }) }],
      queries: [{ match: '赎回费率', response: queryResponse({ traceId: 'tr-query' }) }],
    })
    expect((await port.answer(ANSWER_REQUEST)).traceId).toBe('tr-answer')
    expect((await port.query(QUERY_REQUEST)).traceId).toBe('tr-query')
    expect((await port.health()).corpusVersion).toBe(DEFAULT_FIXTURE_HEALTH.corpusVersion)
  })

  it('falls back to defaults and custom health', async () => {
    const port = createFixtureKnowledgePort({
      defaultAnswer: answerResponse({ traceId: 'tr-default' }),
      defaultQuery: queryResponse({ traceId: 'tr-default-query' }),
      health: { ...DEFAULT_FIXTURE_HEALTH, status: 'degraded', chunks: 0 },
    })
    expect((await port.answer(ANSWER_REQUEST)).traceId).toBe('tr-default')
    expect((await port.query(QUERY_REQUEST)).traceId).toBe('tr-default-query')
    expect((await port.health()).status).toBe('degraded')
  })

  it('fails loud when no fixture matches', async () => {
    const port = createFixtureKnowledgePort({})
    await expect(port.answer(ANSWER_REQUEST)).rejects.toMatchObject({
      code: 'knowledge-fixture-missing',
    })
    await expect(port.query(QUERY_REQUEST)).rejects.toMatchObject({
      code: 'knowledge-fixture-missing',
    })
  })
})
