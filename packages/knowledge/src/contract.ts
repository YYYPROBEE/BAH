/**
 * 契约守卫：把 sidecar 的 JSON 收窄成端口类型。
 *
 * 纪律：不信任网络返回值——字段缺失/类型错误/未知 verdict 一律 `knowledge-contract`，
 * 不做静默兜底（错误必须结构化，见 AGENTS.md 第 5 条）。
 */

import { BahError } from '@bah/util'

import type {
  KnowledgeAnswerResponse,
  KnowledgeCitation,
  KnowledgeEvidence,
  KnowledgeHealth,
  KnowledgeLatency,
  KnowledgeQueryResponse,
  KnowledgeVerdict,
} from './port.ts'

export const KNOWLEDGE_SCHEMA_VERSION = 'knowledge.v1' as const

const VERDICTS: readonly KnowledgeVerdict[] = [
  'GREEN',
  'AMBER_INFERRED',
  'AMBER_DISAMBIGUATION',
  'RED',
  'LOCKED',
]

function fail(path: string, detail: string): never {
  throw new BahError('knowledge-contract', `knowledge 契约错误：${path} ${detail}`, { path })
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, '应为对象')
  }
  return value as Record<string, unknown>
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, '应为字符串')
  return value
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '应为有限数字')
  return value
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, '应为数组')
  return value
}

function optionalString(value: unknown, path: string): string | null | undefined {
  if (value === undefined || value === null) return value
  return string(value, path)
}

function verdict(value: unknown, path: string): KnowledgeVerdict {
  const found = string(value, path)
  if (!VERDICTS.includes(found as KnowledgeVerdict)) fail(path, `未知 verdict ${found}`)
  return found as KnowledgeVerdict
}

function schema(value: unknown, path: string): void {
  if (string(value, `${path}.schemaVersion`) !== KNOWLEDGE_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `只支持 ${KNOWLEDGE_SCHEMA_VERSION}`)
  }
}

function latency(value: unknown, path: string): KnowledgeLatency {
  const item = record(value, path)
  return {
    retrieval: number(item['retrieval'], `${path}.retrieval`),
    generation: number(item['generation'], `${path}.generation`),
    verify: number(item['verify'], `${path}.verify`),
    total: number(item['total'], `${path}.total`),
  }
}

function citation(value: unknown, path: string): KnowledgeCitation {
  const item = record(value, path)
  return {
    marker: string(item['marker'], `${path}.marker`),
    docId: string(item['docId'], `${path}.docId`),
    title: string(item['title'], `${path}.title`),
    clauseNo: optionalString(item['clauseNo'], `${path}.clauseNo`),
    charStart: number(item['charStart'], `${path}.charStart`),
    charEnd: number(item['charEnd'], `${path}.charEnd`),
  }
}

function evidence(value: unknown, path: string): KnowledgeEvidence {
  const item = record(value, path)
  return {
    marker: string(item['marker'], `${path}.marker`),
    chunkId: number(item['chunkId'], `${path}.chunkId`),
    docId: string(item['docId'], `${path}.docId`),
    title: string(item['title'], `${path}.title`),
    clauseNo: optionalString(item['clauseNo'], `${path}.clauseNo`),
    tier: number(item['tier'], `${path}.tier`),
    charStart: number(item['charStart'], `${path}.charStart`),
    charEnd: number(item['charEnd'], `${path}.charEnd`),
    text: string(item['text'], `${path}.text`),
  }
}

/** 校验并返回 answer 响应。 */
export function asKnowledgeAnswer(value: unknown): KnowledgeAnswerResponse {
  const item = record(value, 'answer')
  schema(item['schemaVersion'], 'answer')
  const kind = string(item['kind'], 'answer.kind')
  if (kind !== 'answer' && kind !== 'refusal' && kind !== 'disambiguation') {
    fail('answer.kind', `未知 kind ${kind}`)
  }
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    traceId: string(item['traceId'], 'answer.traceId'),
    kind,
    answer: string(item['answer'], 'answer.answer'),
    citations: array(item['citations'], 'answer.citations').map((entry, index) =>
      citation(entry, `answer.citations[${index}]`),
    ),
    evidence: array(item['evidence'], 'answer.evidence').map((entry, index) =>
      evidence(entry, `answer.evidence[${index}]`),
    ),
    verdict: verdict(item['verdict'], 'answer.verdict'),
    reasonCode: optionalString(item['reasonCode'], 'answer.reasonCode'),
    candidates: array(item['candidates'], 'answer.candidates').map((entry, index) => {
      const candidate = record(entry, `answer.candidates[${index}]`)
      return {
        productId: string(candidate['productId'], `answer.candidates[${index}].productId`),
        name: string(candidate['name'], `answer.candidates[${index}].name`),
      }
    }),
    latencyMs: latency(item['latencyMs'], 'answer.latencyMs'),
  }
}

/** 校验并返回 query 响应。 */
export function asKnowledgeQuery(value: unknown): KnowledgeQueryResponse {
  const item = record(value, 'query')
  schema(item['schemaVersion'], 'query')
  const kind = string(item['kind'], 'query.kind')
  if (kind !== 'evidence' && kind !== 'lookup' && kind !== 'disambiguation' && kind !== 'refusal') {
    fail('query.kind', `未知 kind ${kind}`)
  }
  const route = string(item['route'], 'query.route')
  if (route !== 'hybrid' && route !== 'lookup') fail('query.route', `未知 route ${route}`)
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    traceId: string(item['traceId'], 'query.traceId'),
    kind,
    route,
    visibleCount: number(item['visibleCount'], 'query.visibleCount'),
    answer: string(item['answer'], 'query.answer'),
    evidence: array(item['evidence'], 'query.evidence').map((entry, index) =>
      evidence(entry, `query.evidence[${index}]`),
    ),
    values: array(item['values'], 'query.values').map((entry, index) => {
      const valueItem = record(entry, `query.values[${index}]`)
      return {
        label: string(valueItem['label'], `query.values[${index}].label`),
        valueText: string(valueItem['valueText'], `query.values[${index}].valueText`),
        unit: string(valueItem['unit'], `query.values[${index}].unit`),
        cellRef: string(valueItem['cellRef'], `query.values[${index}].cellRef`),
        formula: optionalString(valueItem['formula'], `query.values[${index}].formula`),
      }
    }),
    candidates: array(item['candidates'], 'query.candidates').map((entry, index) => {
      const candidate = record(entry, `query.candidates[${index}]`)
      return {
        productId: string(candidate['productId'], `query.candidates[${index}].productId`),
        name: string(candidate['name'], `query.candidates[${index}].name`),
      }
    }),
    verdict: verdict(item['verdict'], 'query.verdict'),
    reasonCode: optionalString(item['reasonCode'], 'query.reasonCode'),
    latencyMs: latency(item['latencyMs'], 'query.latencyMs'),
  }
}

/** 校验并返回健康检查。 */
export function asKnowledgeHealth(value: unknown): KnowledgeHealth {
  const item = record(value, 'health')
  schema(item['schemaVersion'], 'health')
  const status = string(item['status'], 'health.status')
  if (status !== 'ok' && status !== 'degraded') fail('health.status', `未知 status ${status}`)
  const embedding = string(item['embedding'], 'health.embedding')
  if (embedding !== 'on' && embedding !== 'off') {
    fail('health.embedding', `未知 embedding ${embedding}`)
  }
  return {
    status,
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    corpusVersion: number(item['corpusVersion'], 'health.corpusVersion'),
    embedVersion: string(item['embedVersion'], 'health.embedVersion'),
    docs: number(item['docs'], 'health.docs'),
    chunks: number(item['chunks'], 'health.chunks'),
    embedding,
  }
}
