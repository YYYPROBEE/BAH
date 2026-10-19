/**
 * 知识平面端口（纯类型，零可执行行）。
 *
 * 纪律：本文件只描述 sidecar 的对外契约；实现（HTTP / fixture）在 client.ts / fixture.ts。
 * 所有字段与 `services/rag/contract.py` 的 camelCase 输出逐字对应。
 */

export type KnowledgeVerdict =
  | 'GREEN'
  | 'AMBER_INFERRED'
  | 'AMBER_DISAMBIGUATION'
  | 'RED'
  | 'LOCKED'

export type KnowledgeAnswerKind = 'answer' | 'refusal' | 'disambiguation'

export type KnowledgeQueryKind = 'evidence' | 'lookup' | 'disambiguation' | 'refusal'

export interface KnowledgePrincipal {
  readonly role: string
  readonly audience: string
  readonly channel: string
  readonly region: string
  readonly productId?: string | null
  /** ISO datetime；服务端只取日期做时效比较。 */
  readonly now: string
}

export interface KnowledgeAnswerOptions {
  readonly style?: 'concise' | 'detailed'
  readonly maxChars?: number
  readonly requireCitations?: boolean
}

export interface KnowledgeAnswerRequest {
  readonly schemaVersion: 'knowledge.v1'
  readonly traceId?: string
  readonly sessionId: string
  readonly query: string
  readonly principal: KnowledgePrincipal
  readonly answerOptions?: KnowledgeAnswerOptions
}

export interface KnowledgeQueryRequest {
  readonly schemaVersion: 'knowledge.v1'
  readonly traceId?: string
  readonly sessionId: string
  readonly query: string
  readonly principal: KnowledgePrincipal
  readonly limits?: Readonly<Record<string, number>>
}

export interface KnowledgeEvidence {
  readonly marker: string
  readonly chunkId: number
  readonly docId: string
  readonly title: string
  readonly clauseNo?: string | null
  readonly tier: number
  readonly charStart: number
  readonly charEnd: number
  readonly text: string
}

export interface KnowledgeCitation {
  readonly marker: string
  readonly docId: string
  readonly title: string
  readonly clauseNo?: string | null
  readonly charStart: number
  readonly charEnd: number
}

export interface KnowledgeCandidate {
  readonly productId: string
  readonly name: string
}

export interface KnowledgeLookupValue {
  readonly label: string
  readonly valueText: string
  readonly unit: string
  readonly cellRef: string
  readonly formula?: string | null
}

export interface KnowledgeLatency {
  readonly retrieval: number
  readonly generation: number
  readonly verify: number
  readonly total: number
}

export interface KnowledgeAnswerResponse {
  readonly schemaVersion: string
  readonly traceId: string
  readonly kind: KnowledgeAnswerKind
  readonly answer: string
  readonly citations: readonly KnowledgeCitation[]
  readonly evidence: readonly KnowledgeEvidence[]
  readonly verdict: KnowledgeVerdict
  readonly reasonCode?: string | null
  readonly candidates: readonly KnowledgeCandidate[]
  readonly latencyMs: KnowledgeLatency
}

export interface KnowledgeQueryResponse {
  readonly schemaVersion: string
  readonly traceId: string
  readonly kind: KnowledgeQueryKind
  readonly route: 'hybrid' | 'lookup'
  readonly visibleCount: number
  readonly answer: string
  readonly evidence: readonly KnowledgeEvidence[]
  readonly values: readonly KnowledgeLookupValue[]
  readonly candidates: readonly KnowledgeCandidate[]
  readonly verdict: KnowledgeVerdict
  readonly reasonCode?: string | null
  readonly latencyMs: KnowledgeLatency
}

export interface KnowledgeHealth {
  readonly status: 'ok' | 'degraded'
  readonly schemaVersion: string
  readonly corpusVersion: number
  readonly embedVersion: string
  readonly docs: number
  readonly chunks: number
  readonly embedding: 'on' | 'off'
}

/** 知识平面端口：宿主只依赖这个接口，不认 HTTP 细节。 */
export interface KnowledgePort {
  answer(
    request: KnowledgeAnswerRequest,
    signal?: AbortSignal,
  ): Promise<KnowledgeAnswerResponse>
  query(request: KnowledgeQueryRequest, signal?: AbortSignal): Promise<KnowledgeQueryResponse>
  health(signal?: AbortSignal): Promise<KnowledgeHealth>
}
