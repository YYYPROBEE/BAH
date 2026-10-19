/**
 * 测试夹具构造器（不导出到包入口；覆盖率名单排除本文件）。
 */

import type {
  KnowledgeAnswerResponse,
  KnowledgeCitation,
  KnowledgeEvidence,
  KnowledgeHealth,
  KnowledgeLatency,
  KnowledgeQueryResponse,
} from './port.ts'

export const LATENCY: KnowledgeLatency = { retrieval: 1, generation: 0, verify: 1, total: 2 }

export const CITATION: KnowledgeCitation = {
  marker: 'K1',
  docId: 'FEE-2025-v3',
  title: '稳盈系列费率表（2025版）',
  clauseNo: '费率表',
  charStart: 0,
  charEnd: 20,
}

export const EVIDENCE: KnowledgeEvidence = {
  marker: 'K1',
  chunkId: 1,
  docId: 'FEE-2025-v3',
  title: '稳盈系列费率表（2025版）',
  clauseNo: '费率表',
  tier: 1,
  charStart: 0,
  charEnd: 20,
  text: '持有不满7天赎回费率1.50%。',
}

export function answerResponse(
  overrides: Partial<KnowledgeAnswerResponse> = {},
): KnowledgeAnswerResponse {
  return {
    schemaVersion: 'knowledge.v1',
    traceId: 'tr-test',
    kind: 'answer',
    answer: '赎回费率为1.50%[K1]。',
    citations: [CITATION],
    evidence: [EVIDENCE],
    verdict: 'GREEN',
    reasonCode: null,
    candidates: [],
    latencyMs: LATENCY,
    ...overrides,
  }
}

export function queryResponse(
  overrides: Partial<KnowledgeQueryResponse> = {},
): KnowledgeQueryResponse {
  return {
    schemaVersion: 'knowledge.v1',
    traceId: 'tr-test',
    kind: 'evidence',
    route: 'hybrid',
    visibleCount: 3,
    answer: '',
    evidence: [EVIDENCE],
    values: [],
    candidates: [],
    verdict: 'GREEN',
    reasonCode: null,
    latencyMs: LATENCY,
    ...overrides,
  }
}

export function healthResponse(overrides: Partial<KnowledgeHealth> = {}): KnowledgeHealth {
  return {
    status: 'ok',
    schemaVersion: 'knowledge.v1',
    corpusVersion: 1,
    embedVersion: 'fixture',
    docs: 10,
    chunks: 10,
    embedding: 'off',
    ...overrides,
  }
}
