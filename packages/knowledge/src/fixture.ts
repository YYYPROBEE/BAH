/**
 * fixture 端口：让快照/单测不启 Python 进程。
 *
 * 匹配规则：按 `match` 子串命中；都没命中时用 `defaultAnswer`/`defaultQuery`，
 * 再没有就抛 `knowledge-fixture-missing`（fail-loud，不返回假答案）。
 */

import { BahError } from '@bah/util'

import type {
  KnowledgeAnswerRequest,
  KnowledgeAnswerResponse,
  KnowledgeHealth,
  KnowledgePort,
  KnowledgeQueryRequest,
  KnowledgeQueryResponse,
} from './port.ts'

export interface AnswerFixture {
  readonly match: string
  readonly response: KnowledgeAnswerResponse
}

export interface QueryFixture {
  readonly match: string
  readonly response: KnowledgeQueryResponse
}

export interface FixtureKnowledgeOptions {
  readonly answers?: readonly AnswerFixture[]
  readonly queries?: readonly QueryFixture[]
  readonly defaultAnswer?: KnowledgeAnswerResponse
  readonly defaultQuery?: KnowledgeQueryResponse
  readonly health?: KnowledgeHealth
}

export const DEFAULT_FIXTURE_HEALTH: KnowledgeHealth = {
  status: 'ok',
  schemaVersion: 'knowledge.v1',
  corpusVersion: 1,
  embedVersion: 'fixture',
  docs: 10,
  chunks: 10,
  embedding: 'off',
}

function pickAnswer(
  options: FixtureKnowledgeOptions,
  request: KnowledgeAnswerRequest,
): KnowledgeAnswerResponse {
  const matched = options.answers?.find((item) => request.query.includes(item.match))
  if (matched !== undefined) return matched.response
  if (options.defaultAnswer !== undefined) return options.defaultAnswer
  throw new BahError('knowledge-fixture-missing', `fixture 没有匹配的 answer：${request.query}`)
}

function pickQuery(
  options: FixtureKnowledgeOptions,
  request: KnowledgeQueryRequest,
): KnowledgeQueryResponse {
  const matched = options.queries?.find((item) => request.query.includes(item.match))
  if (matched !== undefined) return matched.response
  if (options.defaultQuery !== undefined) return options.defaultQuery
  throw new BahError('knowledge-fixture-missing', `fixture 没有匹配的 query：${request.query}`)
}

export function createFixtureKnowledgePort(options: FixtureKnowledgeOptions): KnowledgePort {
  return {
    async answer(request: KnowledgeAnswerRequest): Promise<KnowledgeAnswerResponse> {
      return pickAnswer(options, request)
    },
    async query(request: KnowledgeQueryRequest): Promise<KnowledgeQueryResponse> {
      return pickQuery(options, request)
    },
    async health(): Promise<KnowledgeHealth> {
      return options.health ?? DEFAULT_FIXTURE_HEALTH
    },
  }
}
