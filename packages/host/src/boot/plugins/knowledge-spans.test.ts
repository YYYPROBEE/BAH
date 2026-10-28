/**
 * 知识平面端口的 span 装饰器（可观测性 01 / S1.8）。
 *
 * 守三件容易"看起来对、实际静默错"的事：
 *
 * 1. **属性只能事后补**：`kind` / `verdict` / `citations` 全在响应里，
 *    若改成进入时写死，每一行都是空对象——比不记更坏；
 * 2. **异常原样透传**：装饰器不许包装异常，也不许吞掉；
 * 3. **`health()` 不进轨迹**：探活一次启动只跑一次，记下来只是噪音。
 */

import { createRecorder } from '@bah/telemetry'
import { BahError } from '@bah/util'
import { describe, expect, it, vi } from 'vitest'

import type {
  KnowledgeAnswerResponse,
  KnowledgeHealth,
  KnowledgePort,
  KnowledgeQueryResponse,
} from '@bah/knowledge'

import type { TelemetryHandle } from './telemetry.ts'
import { withKnowledgeSpans } from './knowledge-spans.ts'

const T = 1_700_000_000_000

function answerResponse(overrides: Partial<KnowledgeAnswerResponse> = {}): KnowledgeAnswerResponse {
  return {
    schemaVersion: 'knowledge.v1',
    traceId: 'trace-1',
    kind: 'answer',
    answer: '年费 100 元',
    citations: [
      { marker: '[1]', docId: 'd-1', title: '收费表', charStart: 0, charEnd: 10 },
      { marker: '[2]', docId: 'd-2', title: '补充说明', charStart: 10, charEnd: 20 },
    ],
    evidence: [],
    verdict: 'GREEN',
    candidates: [],
    latencyMs: { retrieval: 1, generation: 2, verify: 1, total: 4 },
    ...overrides,
  }
}

function queryResponse(overrides: Partial<KnowledgeQueryResponse> = {}): KnowledgeQueryResponse {
  return {
    schemaVersion: 'knowledge.v1',
    traceId: 'trace-2',
    kind: 'lookup',
    route: 'lookup',
    visibleCount: 3,
    answer: '3 条依据',
    evidence: [],
    values: [],
    candidates: [],
    verdict: 'AMBER_INFERRED',
    latencyMs: { retrieval: 1, generation: 0, verify: 1, total: 2 },
    ...overrides,
  }
}

/** 只给 `recorder` 的句柄（装饰器不碰其它字段）。 */
function fakeTelemetry() {
  const recorder = createRecorder({ sessionId: 's-rag', now: () => T })
  return { handle: { recorder } as unknown as TelemetryHandle, snapshot: () => recorder.snapshot() }
}

describe('knowledge-spans · 成功路径', () => {
  it('answer 成功后补写 kind/verdict/citations，并原样返回响应', async () => {
    const response = answerResponse()
    const port: KnowledgePort = {
      answer: vi.fn(async () => response),
      query: vi.fn(async () => queryResponse()),
      health: vi.fn(async () => ({ status: 'ok' }) as KnowledgeHealth),
    }
    const { handle, snapshot } = fakeTelemetry()

    const result = await withKnowledgeSpans(port, handle).answer({} as never)

    expect(result).toBe(response)
    const spans = snapshot()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe('rag.answer')
    expect(spans[0]!.status).toBe('ok')
    expect(spans[0]!.endMs).not.toBeNull()
    expect(spans[0]!.attributes).toMatchObject({ kind: 'answer', verdict: 'GREEN', citations: 2 })
  })

  it('query 成功后补写 kind/verdict/visibleCount', async () => {
    const port: KnowledgePort = {
      answer: vi.fn(async () => answerResponse()),
      query: vi.fn(async () => queryResponse()),
      health: vi.fn(async () => ({ status: 'ok' }) as KnowledgeHealth),
    }
    const { handle, snapshot } = fakeTelemetry()

    await withKnowledgeSpans(port, handle).query({} as never)

    const spans = snapshot()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.name).toBe('rag.query')
    expect(spans[0]!.attributes).toMatchObject({ kind: 'lookup', verdict: 'AMBER_INFERRED', visibleCount: 3 })
  })

  it('health 原样透传且不产生 span', async () => {
    const health = { status: 'degraded' } as KnowledgeHealth
    const port: KnowledgePort = {
      answer: vi.fn(async () => answerResponse()),
      query: vi.fn(async () => queryResponse()),
      health: vi.fn(async () => health),
    }
    const { handle, snapshot } = fakeTelemetry()

    expect(await withKnowledgeSpans(port, handle).health()).toBe(health)
    expect(snapshot()).toHaveLength(0)
  })
})

describe('knowledge-spans · 失败路径', () => {
  it('带 code 的异常：span 记 error + 同一 code，异常原样抛出', async () => {
    const error = new BahError('rag-unavailable', 'bah-knowledge: 知识服务不可用')
    const port: KnowledgePort = {
      answer: vi.fn(async () => Promise.reject(error)),
      query: vi.fn(async () => queryResponse()),
      health: vi.fn(async () => ({ status: 'ok' }) as KnowledgeHealth),
    }
    const { handle, snapshot } = fakeTelemetry()

    await expect(withKnowledgeSpans(port, handle).answer({} as never)).rejects.toBe(error)
    const spans = snapshot()
    expect(spans).toHaveLength(1)
    expect(spans[0]!.status).toBe('error')
    expect(spans[0]!.code).toBe('rag-unavailable')
  })

  it('没有 code 的异常记 unknown-error（不把 Error.message 当理由码）', async () => {
    const port: KnowledgePort = {
      answer: vi.fn(async () => answerResponse()),
      query: vi.fn(async () => Promise.reject(new Error('socket hang up'))),
      health: vi.fn(async () => ({ status: 'ok' }) as KnowledgeHealth),
    }
    const { handle, snapshot } = fakeTelemetry()

    await expect(withKnowledgeSpans(port, handle).query({} as never)).rejects.toThrow('socket hang up')
    expect(snapshot()[0]!.code).toBe('unknown-error')
  })
})
