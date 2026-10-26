/**
 * 可验证的知识端口（W06）：在 sidecar / fixture 与工具之间加一道**本地验签**。
 *
 * 位置：`KnowledgePort` 的装饰器。检索命中后、工具组装 content 前逐条核对证据：
 * - `(docId, chunkId, text)` 的 sha256 必须等于签名清单里的 `textSha256`；
 * - 条目的 HMAC 必须用本地密钥重算一致。
 *
 * 失败语义：**该条视为未命中**；只要响应里有任何一条证据验签失败，整条答案降级为拒答
 * （`kind: 'refusal'` + `reasonCode: 'signature-invalid'`），因为答案文本可能引用了坏条目。
 * 拒答会顺着既有 `knowledge/answered` 事件落账，不新增事件类型。
 */

import type {
  KnowledgeAnswerResponse,
  KnowledgeCitation,
  KnowledgeEvidence,
  KnowledgePort,
  KnowledgeQueryResponse,
} from './port.ts'
import {
  SIGNATURE_INVALID_CODE,
  digestEquals,
  entryHmacInput,
  hmacHex,
  sha256Hex,
  type ManifestEntry,
} from './sign.ts'

/** 拒答文案（稳定理由码，供 eval / 审计检索）。 */
export const SIGNATURE_REFUSAL_TEXT =
  '【拒答】知识库条目签名校验失败，无法作为权威依据。（reasonCode: signature-invalid）'

/** 验签失败的细节（宿主可转成审计/日志；默认不落用户可见文本以外的内容）。 */
export interface SignatureRejection {
  readonly reasonCode: typeof SIGNATURE_INVALID_CODE
  readonly docId?: string
  readonly chunkId?: number
  readonly detail: string
}

/** `createVerifiedKnowledgePort` 的选项。 */
export interface VerifiedKnowledgeOptions {
  readonly port: KnowledgePort
  /** 当前模式可用的条目（http = corpus；fixture = fixture）。 */
  readonly entries: readonly ManifestEntry[]
  readonly key: string
  /** 命中坏条目时回调（测试用来断言"是验签失败，不是没检索到"）。 */
  readonly onRejected?: (rejection: SignatureRejection) => void
}

/** 装饰端口：所有 answer/query 的返回值都先过条目验签。 */
export function createVerifiedKnowledgePort(options: VerifiedKnowledgeOptions): KnowledgePort {
  const index = new Map<string, ManifestEntry>()
  for (const entry of options.entries) {
    index.set(indexKey(entry.docId, entry.chunkId), entry)
  }

  const check = (evidence: KnowledgeEvidence): SignatureRejection | undefined => {
    const entry = index.get(indexKey(evidence.docId, evidence.chunkId))
    if (entry === undefined) {
      const rejection: SignatureRejection = {
        reasonCode: SIGNATURE_INVALID_CODE,
        docId: evidence.docId,
        chunkId: evidence.chunkId,
        detail: '签名清单里没有该条目（未知来源 / 未签名语料）',
      }
      options.onRejected?.(rejection)
      return rejection
    }
    const digest = sha256Hex(evidence.text)
    if (digest !== entry.textSha256) {
      const rejection: SignatureRejection = {
        reasonCode: SIGNATURE_INVALID_CODE,
        docId: evidence.docId,
        chunkId: evidence.chunkId,
        detail: '证据文本与签名摘要不一致（语料被篡改 / 服务端内容漂移）',
      }
      options.onRejected?.(rejection)
      return rejection
    }
    const source = entry.source
    const expectedHmac = hmacHex(options.key, entryHmacInput(source, entry.docId, entry.chunkId, digest))
    if (!digestEquals(entry.hmac, expectedHmac)) {
      const rejection: SignatureRejection = {
        reasonCode: SIGNATURE_INVALID_CODE,
        docId: evidence.docId,
        chunkId: evidence.chunkId,
        detail: '条目 HMAC 不匹配（清单签名无效）',
      }
      options.onRejected?.(rejection)
      return rejection
    }
    return undefined
  }

  const evaluate = (
    evidence: readonly KnowledgeEvidence[],
    citations: readonly KnowledgeCitation[],
  ): SignatureRejection | undefined => {
    const valid = new Map<string, KnowledgeEvidence>()
    for (const item of evidence) {
      const rejection = check(item)
      if (rejection !== undefined) return rejection
      valid.set(evidenceKey(item), item)
    }
    for (const citation of citations) {
      if (!valid.has(citationKey(citation))) {
        const rejection: SignatureRejection = {
          reasonCode: SIGNATURE_INVALID_CODE,
          docId: citation.docId,
          detail: '引用没有对应的已签名证据（可能被篡改或拼接）',
        }
        options.onRejected?.(rejection)
        return rejection
      }
    }
    return undefined
  }

  return {
    async answer(request, signal) {
      const response = await options.port.answer(request, signal)
      if (response.kind === 'refusal') return response
      if (response.kind === 'answer' && response.evidence.length === 0) {
        const rejection: SignatureRejection = {
          reasonCode: SIGNATURE_INVALID_CODE,
          detail: '权威答案没有可验签的证据（无证据 = 不可作为权威依据）',
        }
        options.onRejected?.(rejection)
        return refuseAnswer(response)
      }
      const rejection = evaluate(response.evidence, response.citations)
      if (rejection === undefined) return response
      return refuseAnswer(response)
    },

    async query(request, signal) {
      const response = await options.port.query(request, signal)
      if (response.kind === 'refusal') return response
      if (response.kind !== 'disambiguation' && response.evidence.length === 0) {
        const rejection: SignatureRejection = {
          reasonCode: SIGNATURE_INVALID_CODE,
          detail: '检索结果没有可验签的证据（无证据 = 不可作为权威依据）',
        }
        options.onRejected?.(rejection)
        return refuseQuery(response)
      }
      const rejection = evaluate(response.evidence, [])
      if (rejection === undefined) return response
      return refuseQuery(response)
    },

    async health(signal) {
      return options.port.health(signal)
    },
  }
}

/** 答案 → 拒答（保留 traceId / latency / candidates，清空全部权威内容）。 */
export function refuseAnswer(response: KnowledgeAnswerResponse): KnowledgeAnswerResponse {
  return {
    ...response,
    kind: 'refusal',
    answer: SIGNATURE_REFUSAL_TEXT,
    citations: [],
    evidence: [],
    verdict: 'RED',
    reasonCode: SIGNATURE_INVALID_CODE,
  }
}

/** 检索结果 → 拒答。 */
export function refuseQuery(response: KnowledgeQueryResponse): KnowledgeQueryResponse {
  return {
    ...response,
    kind: 'refusal',
    visibleCount: 0,
    answer: SIGNATURE_REFUSAL_TEXT,
    evidence: [],
    values: [],
    verdict: 'RED',
    reasonCode: SIGNATURE_INVALID_CODE,
  }
}

/** 清单条目是否覆盖了给定证据（启动期用：清单与语料不同步要 fail-loud）。 */
export function missingEntryFor(
  entries: readonly ManifestEntry[],
  evidence: readonly { readonly docId: string; readonly chunkId: number; readonly text: string }[],
): { readonly docId: string; readonly chunkId: number } | undefined {
  const index = new Set(entries.map((entry) => `${entry.docId}#${String(entry.chunkId)}`))
  for (const item of evidence) {
    const key = `${item.docId}#${String(item.chunkId)}`
    if (!index.has(key)) return { docId: item.docId, chunkId: item.chunkId }
    const entry = entries.find(
      (candidate) => candidate.docId === item.docId && candidate.chunkId === item.chunkId,
    )
    if (entry === undefined || entry.textSha256 !== sha256Hex(item.text)) {
      return { docId: item.docId, chunkId: item.chunkId }
    }
  }
  return undefined
}

function indexKey(docId: string, chunkId: number): string {
  return `${docId}#${String(chunkId)}`
}

function evidenceKey(item: KnowledgeEvidence): string {
  return `${item.docId}#${String(item.charStart)}#${String(item.charEnd)}`
}

function citationKey(item: KnowledgeCitation): string {
  return `${item.docId}#${String(item.charStart)}#${String(item.charEnd)}`
}
