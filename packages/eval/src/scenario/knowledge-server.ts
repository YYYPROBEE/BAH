/**
 * K 族的确定性知识服务（本地 HTTP，W13）。
 *
 * 为什么起 HTTP 而不是走 fixture 端口：K 族要测"签名门在 http 模式下仍生效"，
 * 而 fixture 端口的可信度来自启动时的文件签名。起一个真实回环服务，才能让
 * `createHttpKnowledgePort` + `createVerifiedKnowledgePort` 走完整链路。
 *
 * 服务**只服务评测**：响应由问题文本决定（确定性），不联网、不读密钥、不写盘。
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { KNOWLEDGE_SCHEMA_VERSION } from '@bah/knowledge'

import type { KnowledgeAnswerResponse, KnowledgeQueryResponse } from '@bah/knowledge'

const FIXTURE_QUERY = '稳盈90天持有不满7天赎回费率是多少？'
const TRACE = 'tr-eval-knowledge'

/** 一条已签名语料（从 `corpus.json` 读入）。 */
interface CorpusDoc {
  readonly docId: string
  readonly chunkId: number
  readonly title: string
  readonly text: string
}

/** 本地服务句柄。 */
export interface KnowledgeEvalServer {
  readonly url: string
  close(): Promise<void>
}

/** 起服务（端口 0 = 随机空闲端口）。 */
export async function startKnowledgeEvalServer(corpusPath: string): Promise<KnowledgeEvalServer> {
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { docs: readonly CorpusDoc[] }
  const signed = corpus.docs.find((doc) => doc.docId === 'FEE-2025-v3') ?? corpus.docs[0]
  if (signed === undefined) throw new Error('评测知识服务：corpus.json 里没有语料')

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, {
        status: 'ok',
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        corpusVersion: 1,
        embedVersion: 'eval',
        docs: corpus.docs.length,
        chunks: corpus.docs.length,
        embedding: 'off',
      })
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(404)
      response.end()
      return
    }
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      const query = readQuery(raw)
      if (request.url === '/v1/answer') {
        sendJson(response, answerFor(query, signed))
        return
      }
      if (request.url === '/v1/query') {
        sendJson(response, queryFor(query, signed))
        return
      }
      response.writeHead(404)
      response.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** 问题 → 答案（确定性分支）。 */
function answerFor(question: string, doc: CorpusDoc): KnowledgeAnswerResponse {
  if (question.includes('VIP')) return refusal('SCOPE_EMPTY', '当前权限范围内没有可引用的依据，无法回答该问题。')
  if (question.includes('签名失效')) return answerWith(doc, { tamperText: '持有不满7天赎回费率0.00%。' })
  if (question.includes('未知条目')) return answerWith(doc, { unknown: true })
  if (question.includes('无证据')) return answerWith(doc, { noEvidence: true })
  if (question.includes('引用错位')) return answerWith(doc, { badCitation: true })
  return answerWith(doc, {})
}

/** 问题 → 检索结果。 */
function queryFor(question: string, doc: CorpusDoc): KnowledgeQueryResponse {
  if (question.includes('查询拒答')) {
    const evidence = evidenceOf(doc, '持有不满7天赎回费率0.00%。')
    return {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      traceId: TRACE,
      kind: 'lookup',
      route: 'lookup',
      visibleCount: 1,
      answer: '',
      evidence: [evidence],
      values: [{ label: '赎回费率（持有<7天）', valueText: '0.00', unit: '%', cellRef: 'c-eval', formula: null }],
      candidates: [],
      verdict: 'GREEN',
      reasonCode: null,
      latencyMs: zeroLatency(),
    }
  }
  const evidence = evidenceOf(doc, doc.text)
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    traceId: TRACE,
    kind: 'lookup',
    route: 'lookup',
    visibleCount: 1,
    answer: '',
    evidence: [evidence],
    values: [{ label: '赎回费率（持有<7天）', valueText: '1.50', unit: '%', cellRef: 'c-eval', formula: null }],
    candidates: [],
    verdict: 'GREEN',
    reasonCode: null,
    latencyMs: zeroLatency(),
  }
}

/** 正常答案 / 各种坏证据变体。 */
function answerWith(
  doc: CorpusDoc,
  options: {
    readonly tamperText?: string
    readonly unknown?: boolean
    readonly noEvidence?: boolean
    readonly badCitation?: boolean
  },
): KnowledgeAnswerResponse {
  if (options.noEvidence === true) {
    return {
      ...baseAnswer(doc),
      citations: [],
      evidence: [],
    }
  }
  const text = options.tamperText ?? doc.text
  const evidence = {
    ...evidenceOf(doc, text),
    ...(options.unknown === true ? { docId: 'GHOST-DOC', chunkId: 999 } : {}),
  }
  const citation = {
    marker: 'K1',
    docId: evidence.docId,
    title: doc.title,
    clauseNo: '费率表',
    charStart: 0,
    charEnd: options.badCitation === true ? text.length + 1 : text.length,
  }
  return {
    ...baseAnswer(doc),
    citations: [citation],
    evidence: [evidence],
  }
}

function baseAnswer(doc: CorpusDoc): KnowledgeAnswerResponse {
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    traceId: TRACE,
    kind: 'answer',
    answer: `赎回费率（持有<7天）为1.50%[K1]（评测夹具：${doc.title}）。`,
    citations: [],
    evidence: [],
    verdict: 'GREEN',
    reasonCode: null,
    candidates: [],
    latencyMs: zeroLatency(),
  }
}

function evidenceOf(doc: CorpusDoc, text: string) {
  return {
    marker: 'K1',
    chunkId: doc.chunkId,
    docId: doc.docId,
    title: doc.title,
    clauseNo: '费率表',
    tier: 1,
    charStart: 0,
    charEnd: text.length,
    text,
  }
}

function refusal(reasonCode: string, answer: string): KnowledgeAnswerResponse {
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    traceId: TRACE,
    kind: 'refusal',
    answer,
    citations: [],
    evidence: [],
    verdict: 'RED',
    reasonCode,
    candidates: [],
    latencyMs: zeroLatency(),
  }
}

function zeroLatency(): { retrieval: number; generation: number; verify: number; total: number } {
  return { retrieval: 0, generation: 0, verify: 0, total: 0 }
}

function readQuery(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { query?: unknown }
    return typeof parsed.query === 'string' ? parsed.query : ''
  } catch {
    return ''
  }
}

function sendJson(response: import('node:http').ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** 供场景文件引用的固定问题（保证报告里的输入可复现）。 */
export const KNOWLEDGE_QUESTIONS = {
  hit: FIXTURE_QUERY,
  hitSecond: '稳盈90天申购费率是多少？',
  vip: 'VIP 专属产品的费率是多少？',
  signature: '签名失效：赎回费率是多少？',
  unknown: '未知条目：赎回费率是多少？',
  noEvidence: '无证据：赎回费率是多少？',
  badCitation: '引用错位：赎回费率是多少？',
  queryHit: '查询稳盈90天赎回费率',
  queryRefusal: '查询拒答：赎回费率是多少？',
} as const
