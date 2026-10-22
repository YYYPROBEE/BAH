/**
 * 知识领域 durable 会话事件（`SessionEventMap` 模块增强）。
 *
 * 事件只记"发生过什么"的摘要，不存答案正文：
 * 正文在 `tool/result`（模型可见）与 RAG `answer_log`（本地），面板用 traceId 联查。
 */

import type { KnowledgeAnswerKind, KnowledgeVerdict } from './port.ts'

export const KNOWLEDGE_EVENT_TYPES = [
  'knowledge/answered',
  'knowledge/queried',
] as const

export interface KnowledgeAnsweredData {
  readonly traceId: string
  readonly kind: KnowledgeAnswerKind
  readonly verdict: KnowledgeVerdict
  readonly reasonCode?: string | null
  readonly citationCount: number
  readonly answerChars: number
  readonly at: number
}

export interface KnowledgeQueriedData {
  readonly traceId: string
  readonly kind: 'evidence' | 'lookup' | 'disambiguation' | 'refusal'
  readonly visibleCount: number
  readonly verdict: KnowledgeVerdict
  readonly reasonCode?: string | null
  readonly citationCount: number
  readonly at: number
}

declare module '@bah/core' {
  interface SessionEventMap {
    'knowledge/answered': KnowledgeAnsweredData
    'knowledge/queried': KnowledgeQueriedData
  }
}
