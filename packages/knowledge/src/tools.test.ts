import { describe, expect, it, vi } from 'vitest'

import type { SessionId, ToolExecContext } from '@bah/core'

import { createKnowledgeTools } from './tools.ts'
import { CITATION, answerResponse, queryResponse } from './testing.ts'
import type { KnowledgeAnswerResponse, KnowledgePort, KnowledgeQueryResponse } from './port.ts'

const SESSION = 's-1' as unknown as SessionId

function context(): ToolExecContext {
  return {
    sessionId: SESSION,
    callId: 'call-1',
    signal: new AbortController().signal,
  }
}

function fakePort(overrides: Partial<KnowledgePort> = {}): KnowledgePort {
  return {
    answer: vi.fn(async (): Promise<KnowledgeAnswerResponse> => answerResponse()),
    query: vi.fn(async (): Promise<KnowledgeQueryResponse> => queryResponse()),
    health: vi.fn(async () => ({
      status: 'ok' as const,
      schemaVersion: 'knowledge.v1',
      corpusVersion: 1,
      embedVersion: 'fixture',
      docs: 1,
      chunks: 1,
      embedding: 'off' as const,
    })),
    ...overrides,
  }
}

const PRINCIPAL = {
  role: 'retail',
  audience: 'standard',
  channel: 'headless',
  region: 'CN-SH',
  now: '2026-10-19T12:00:00+08:00',
} as const

describe('knowledge tools', () => {
  it('exposes only question/productHint in the schema', () => {
    const [answerTool, queryTool] = createKnowledgeTools({
      port: fakePort(),
      principalOf: () => PRINCIPAL,
    })
    for (const tool of [answerTool, queryTool]) {
      expect(Object.keys(tool.schema.properties ?? {})).toEqual(['question', 'productHint'])
      expect(tool.schema.required).toEqual(['question'])
      expect(tool.tier.level).toBe('green')
    }
    expect(answerTool.name).toBe('knowledge_answer')
    expect(queryTool.name).toBe('knowledge_query')
  })

  it('answers with principal injected from the session', async () => {
    const onAnswered = vi.fn()
    const port = fakePort()
    const [answerTool] = createKnowledgeTools({
      port,
      principalOf: () => PRINCIPAL,
      maskPii: (text) => text.replace('13800001111', '***'),
      onAnswered,
    })
    const result = await answerTool.execute(
      { question: '我的手机13800001111，稳盈90天赎回费率' },
      context(),
    )
    expect(result.verdict).toBe('GREEN')
    expect(port.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's-1',
        query: '我的手机***，稳盈90天赎回费率',
        principal: PRINCIPAL,
      }),
      expect.anything(),
    )
    expect(onAnswered).toHaveBeenCalledWith({ sessionId: SESSION, response: result })
  })

  it('masks phone numbers by default before leaving the process', async () => {
    const port = fakePort()
    const [answerTool] = createKnowledgeTools({
      port,
      principalOf: () => PRINCIPAL,
    })
    await answerTool.execute({ question: '我的手机13800001111，稳盈90天赎回费率' }, context())
    expect(port.answer).toHaveBeenCalledWith(
      expect.objectContaining({ query: '我的手机***，稳盈90天赎回费率' }),
      expect.anything(),
    )
  })

  it('renders answer content with citations and a card', () => {
    const [answerTool] = createKnowledgeTools({
      port: fakePort(),
      principalOf: () => PRINCIPAL,
    })
    const result = answerResponse()
    const content = answerTool.projectContent?.(result) ?? []
    expect(content[0]).toMatchObject({ type: 'text' })
    expect((content[0] as { text: string }).text).toContain('引用：')
    expect((content[0] as { text: string }).text).toContain('[K1]')

    const card = answerTool.presentResult?.({ question: 'q' }, result)
    expect(card?.kind).toBe('knowledge.answer')
    expect(card?.data).toMatchObject({ traceId: 'tr-test', verdict: 'GREEN' })
  })

  it('renders a citation without a clause number', () => {
    const [answerTool] = createKnowledgeTools({
      port: fakePort(),
      principalOf: () => PRINCIPAL,
    })
    const result = answerResponse({ citations: [{ ...CITATION, clauseNo: null }] })
    const content = answerTool.projectContent?.(result) ?? []
    const text = (content[0] as unknown as { text: string }).text
    expect(text).toContain('[K1] 稳盈系列费率表（2025版）')
    expect(text).not.toContain('费率表 ')
  })

  it('renders a refusal without a citation block', () => {
    const [answerTool] = createKnowledgeTools({
      port: fakePort(),
      principalOf: () => PRINCIPAL,
    })
    const refusal = answerResponse({
      kind: 'refusal',
      answer: '当前权限范围内没有可引用的依据。',
      citations: [],
      evidence: [],
      verdict: 'RED',
      reasonCode: 'SCOPE_EMPTY',
    })
    const content = answerTool.projectContent?.(refusal) ?? []
    expect((content[0] as { text: string }).text).toBe('当前权限范围内没有可引用的依据。')
    expect(answerTool.presentResult?.({ question: 'q' }, refusal)?.data).toMatchObject({
      verdict: 'RED',
      reasonCode: 'SCOPE_EMPTY',
    })
  })

  it('queries evidence and lookup values', async () => {
    const onQueried = vi.fn()
    const [, queryTool] = createKnowledgeTools({
      port: fakePort(),
      principalOf: () => PRINCIPAL,
      onQueried,
    })
    const result = await queryTool.execute({ question: '稳盈90天' }, context())
    expect(result.kind).toBe('evidence')
    expect(onQueried).toHaveBeenCalledWith({ sessionId: SESSION, response: result })

    const evidenceText = (queryTool.projectContent?.(result) ?? [])[0] as { text: string }
    expect(evidenceText.text).toContain('知识库证据')

    const lookup = queryResponse({
      kind: 'lookup',
      values: [
        {
          label: '赎回费率（持有<7天）',
          valueText: '1.50',
          unit: '%',
          cellRef: 'c-1',
        },
      ],
    })
    const lookupText = (queryTool.projectContent?.(lookup) ?? [])[0] as { text: string }
    expect(lookupText.text).toContain('结构化取数结果')

    const refusal = queryResponse({
      kind: 'refusal',
      answer: '没有依据',
      evidence: [],
      values: [],
      verdict: 'RED',
      reasonCode: 'SCOPE_EMPTY',
    })
    const refusalText = (queryTool.projectContent?.(refusal) ?? [])[0] as { text: string }
    expect(refusalText.text).toBe('没有依据')

    const card = queryTool.presentResult?.({ question: 'q' }, result)
    expect(card?.kind).toBe('knowledge.evidence')
  })
})
