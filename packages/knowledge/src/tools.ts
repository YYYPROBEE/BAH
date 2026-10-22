/**
 * 知识工具族：`knowledge_answer`（主）与 `knowledge_query`（混合问题证据）。
 *
 * 安全关键：
 * - 模型可见参数只有 question / productHint；principal 由宿主按 sessionId 组装，
 *   模型无法传入 role/audience/channel/region；
 * - 出网前对 query 做 PII 脱敏（由宿主注入 maskPii，缺省 identity）；
 * - 工具只返回 sidecar 的已校验结果，不在 TS 侧改写答案。
 */

import type {
  ContentBlock,
  SessionId,
  ToolDefinition,
  ToolExecContext,
  UiCard,
} from '@bah/core'

import type {
  KnowledgeAnswerRequest,
  KnowledgeAnswerResponse,
  KnowledgePort,
  KnowledgePrincipal,
  KnowledgeQueryRequest,
  KnowledgeQueryResponse,
} from './port.ts'

export interface KnowledgeAnswerArgs {
  readonly question: string
  readonly productHint?: string
}

export interface KnowledgeQueryArgs {
  readonly question: string
  readonly productHint?: string
}

export interface KnowledgeToolDeps {
  readonly port: KnowledgePort
  readonly principalOf: (sessionId: SessionId) => KnowledgePrincipal
  /** PII 脱敏；缺省不处理（测试/无 sentry 场景）。 */
  readonly maskPii?: (text: string) => string
  /** 审计挂点：宿主插件用它落 `knowledge/answered`。 */
  readonly onAnswered?: (input: {
    readonly sessionId: SessionId
    readonly response: KnowledgeAnswerResponse
  }) => void
  readonly onQueried?: (input: {
    readonly sessionId: SessionId
    readonly response: KnowledgeQueryResponse
  }) => void
}

const ANSWER_DESCRIPTION =
  '回答银行产品/费率/限额/条款/流程类问题。返回已校验答案与引用；' +
  '调用后最终回复只写一句引导语，不要改写 answer 字段。'

const QUERY_DESCRIPTION =
  '查询银行知识库，返回证据或结构化取数结果（不含生成答案）。' +
  '仅在需要与账户/交易数据组合时使用；纯知识问题请用 knowledge_answer。'

const ARGS_SCHEMA = {
  type: 'object' as const,
  properties: {
    question: {
      type: 'string',
      description: '用户原问题（可含产品名/期限/金额）',
    },
    productHint: {
      type: 'string',
      description: '可选：用户已点名的产品名，仅作提示',
    },
  },
  required: ['question'] as const,
}

const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g
const LONG_DIGITS_RE = /(?<!\d)\d{12,19}(?!\d)/g

/** 出网前的轻量 PII 脱敏：手机号 / 长账号；不碰产品名与条款号。 */
export function maskQueryPii(text: string): string {
  return text.replace(PHONE_RE, '***').replace(LONG_DIGITS_RE, '***')
}

function citationText(response: KnowledgeAnswerResponse): string {
  if (response.citations.length === 0) return response.answer
  const lines = response.citations.map((citation) => {
    const clause = citation.clauseNo === null || citation.clauseNo === undefined
      ? ''
      : ` ${citation.clauseNo}`
    return `[${citation.marker}] ${citation.title}${clause}`
  })
  return [response.answer, '', '引用：', ...lines].join('\n')
}

function queryText(response: KnowledgeQueryResponse): string {
  if (response.kind === 'lookup' && response.values.length > 0) {
    const lines = response.values.map(
      (value) => `- ${value.label}：${value.valueText}${value.unit}`,
    )
    return ['结构化取数结果：', ...lines].join('\n')
  }
  if (response.kind === 'evidence' && response.evidence.length > 0) {
    const lines = response.evidence.map(
      (item) => `[${item.marker}] ${item.title}：${item.text}`,
    )
    return ['知识库证据：', ...lines].join('\n')
  }
  return response.answer
}

/** 组装两个知识工具；宿主插件负责注册。 */
export function createKnowledgeTools(deps: KnowledgeToolDeps): [
  ToolDefinition<KnowledgeAnswerArgs, KnowledgeAnswerResponse>,
  ToolDefinition<KnowledgeQueryArgs, KnowledgeQueryResponse>,
] {
  const mask = deps.maskPii ?? maskQueryPii

  const answerTool: ToolDefinition<KnowledgeAnswerArgs, KnowledgeAnswerResponse> = {
    name: 'knowledge_answer',
    description: ANSWER_DESCRIPTION,
    schema: ARGS_SCHEMA,
    tier: { level: 'green' },
    async execute(args: KnowledgeAnswerArgs, ctx: ToolExecContext): Promise<KnowledgeAnswerResponse> {
      const request: KnowledgeAnswerRequest = {
        schemaVersion: 'knowledge.v1',
        sessionId: String(ctx.sessionId),
        query: mask(args.question),
        principal: deps.principalOf(ctx.sessionId),
      }
      const response = await deps.port.answer(request, ctx.signal)
      deps.onAnswered?.({ sessionId: ctx.sessionId, response })
      return response
    },
    projectContent(result: KnowledgeAnswerResponse): ContentBlock[] {
      return [{ type: 'text', text: citationText(result) }]
    },
    presentResult(_args: KnowledgeAnswerArgs, result: KnowledgeAnswerResponse): UiCard {
      return {
        kind: 'knowledge.answer',
        data: {
          traceId: result.traceId,
          kind: result.kind,
          answer: result.answer,
          citations: result.citations,
          verdict: result.verdict,
          reasonCode: result.reasonCode ?? null,
        },
      }
    },
  }

  const queryTool: ToolDefinition<KnowledgeQueryArgs, KnowledgeQueryResponse> = {
    name: 'knowledge_query',
    description: QUERY_DESCRIPTION,
    schema: ARGS_SCHEMA,
    tier: { level: 'green' },
    async execute(args: KnowledgeQueryArgs, ctx: ToolExecContext): Promise<KnowledgeQueryResponse> {
      const request: KnowledgeQueryRequest = {
        schemaVersion: 'knowledge.v1',
        sessionId: String(ctx.sessionId),
        query: mask(args.question),
        principal: deps.principalOf(ctx.sessionId),
      }
      const response = await deps.port.query(request, ctx.signal)
      deps.onQueried?.({ sessionId: ctx.sessionId, response })
      return response
    },
    projectContent(result: KnowledgeQueryResponse): ContentBlock[] {
      return [{ type: 'text', text: queryText(result) }]
    },
    presentResult(_args: KnowledgeQueryArgs, result: KnowledgeQueryResponse): UiCard {
      return {
        kind: 'knowledge.evidence',
        data: {
          traceId: result.traceId,
          kind: result.kind,
          verdict: result.verdict,
          reasonCode: result.reasonCode ?? null,
          citations: result.evidence.map((item) => ({
            marker: item.marker,
            docId: item.docId,
            title: item.title,
            clauseNo: item.clauseNo ?? null,
          })),
        },
      }
    },
  }

  return [answerTool, queryTool]
}
