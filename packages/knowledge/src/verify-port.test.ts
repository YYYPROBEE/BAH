/**
 * W06 可验证端口：HTTP / in-process 两条路径都在本地逐条验签
 * （TC-W06-02、06、08）。
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createFixtureKnowledgePort } from './fixture.ts'
import { createHttpKnowledgePort } from './client.ts'
import type {
  KnowledgeAnswerResponse,
  KnowledgePort,
  KnowledgePrincipal,
  KnowledgeQueryResponse,
} from './port.ts'
import { loadManifest, requireKnowledgeKey, sha256Hex, type ManifestEntry } from './sign.ts'
import {
  SIGNATURE_REFUSAL_TEXT,
  createVerifiedKnowledgePort,
  missingEntryFor,
} from './verify-port.ts'

const ROOT = process.cwd()
const MANIFEST_PATH = 'packages/knowledge/fixtures/knowledge.manifest.json'
const FIXTURE_PATH = 'packages/knowledge/fixtures/headless.json'
const KEY = requireKnowledgeKey()

interface FixtureFile {
  readonly answers: readonly { readonly match: string; readonly response: KnowledgeAnswerResponse }[]
  readonly queries: readonly { readonly match: string; readonly response: KnowledgeQueryResponse }[]
  readonly health: unknown
}

const fixture = JSON.parse(readFileSync(join(ROOT, FIXTURE_PATH), 'utf8')) as FixtureFile
const manifest = loadManifest(ROOT, MANIFEST_PATH)
const fixtureEntries = manifest.entries.filter((entry) => entry.source === 'fixture')

const PRINCIPAL: KnowledgePrincipal = {
  role: 'retail',
  audience: 'standard',
  channel: 'headless',
  region: 'CN-SH',
  productId: null,
  now: '2026-10-26T00:00:00.000Z',
}

const ANSWER_REQUEST = {
  schemaVersion: 'knowledge.v1' as const,
  sessionId: 's-w06',
  query: '稳盈90天持有不满7天赎回费率是多少？',
  principal: PRINCIPAL,
}

const QUERY_REQUEST = {
  schemaVersion: 'knowledge.v1' as const,
  sessionId: 's-w06',
  query: '稳盈90天赎回费率',
  principal: PRINCIPAL,
}

const servers: { close: (callback: () => void) => void }[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function verified(port: KnowledgePort, onRejected?: (info: unknown) => void): KnowledgePort {
  return createVerifiedKnowledgePort({ port, entries: fixtureEntries, key: KEY, ...(onRejected === undefined ? {} : { onRejected }) })
}

function tamperedAnswer(): KnowledgeAnswerResponse {
  const base = fixture.answers[0]?.response
  if (base === undefined) throw new Error('fixture 缺少答案')
  return {
    ...base,
    evidence: base.evidence.map((item) => ({ ...item, text: '持有不满7天赎回费率0.00%。' })),
  }
}

describe('W06 · 可验证端口', () => {
  it('TC-W06-08 同一问题：正常语料命中，篡改证据后拒答（前后文本不同）', async () => {
    const honest = verified(
      createFixtureKnowledgePort({
        answers: fixture.answers,
        queries: fixture.queries,
      }),
    )
    const before = await honest.answer(ANSWER_REQUEST)
    expect(before.kind).toBe('answer')
    expect(before.answer).toContain('1.50')

    const tampered = verified(
      createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: tamperedAnswer() }],
        queries: [],
      }),
    )
    const after = await tampered.answer(ANSWER_REQUEST)
    expect(after.kind).toBe('refusal')
    expect(after.answer).toBe(SIGNATURE_REFUSAL_TEXT)
    expect(after.reasonCode).toBe('signature-invalid')
    expect(after.answer).not.toBe(before.answer)
  })

  it('TC-W06-02 篡改一条语料 → 该条视为未命中并拒答（带 reasonCode）', async () => {
    const rejections: unknown[] = []
    const port = verified(
      createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: tamperedAnswer() }],
        queries: [],
      }),
      (info) => rejections.push(info),
    )
    const response = await port.answer(ANSWER_REQUEST)
    expect(response.kind).toBe('refusal')
    expect(response.verdict).toBe('RED')
    expect(response.reasonCode).toBe('signature-invalid')
    expect(response.evidence).toEqual([])
    expect(response.citations).toEqual([])
    expect(rejections).toHaveLength(1)
    expect((rejections[0] as { detail: string }).detail).toContain('摘要')
  })

  it('TC-W06-06 http 模式：本地验签仍然生效（不依赖服务端）', async () => {
    let calls = 0
    const good = fixture.answers[0]?.response
    if (good === undefined) throw new Error('fixture 缺少答案')
    const bad = tamperedAnswer()
    const server = createServer((request, response) => {
      if (request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(fixture.health))
        return
      }
      if (request.url === '/v1/answer') {
        calls += 1
        const body = calls === 1 ? good : bad
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
        return
      }
      response.writeHead(404)
      response.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo

    const port = verified(
      createHttpKnowledgePort({ baseUrl: `http://127.0.0.1:${String(address.port)}` }),
    )
    const first = await port.answer(ANSWER_REQUEST)
    expect(first.kind).toBe('answer')

    const second = await port.answer(ANSWER_REQUEST)
    expect(second.kind).toBe('refusal')
    expect(second.reasonCode).toBe('signature-invalid')
  })

  it('query / 引用 / 未知条目 / 无证据 都在本地被拦', async () => {
    const queryBase = fixture.queries[0]?.response
    if (queryBase === undefined) throw new Error('fixture 缺少 query')
    const tamperedQuery: KnowledgeQueryResponse = {
      ...queryBase,
      evidence: queryBase.evidence.map((item) => ({ ...item, text: '伪造费率 0.00%。' })),
    }
    const queryPort = verified(
      createFixtureKnowledgePort({ answers: [], queries: [{ match: '稳盈90天', response: tamperedQuery }] }),
    )
    const query = await queryPort.query(QUERY_REQUEST)
    expect(query.kind).toBe('refusal')
    expect(query.values).toEqual([])
    expect(query.reasonCode).toBe('signature-invalid')

    const answerBase = fixture.answers[0]?.response
    if (answerBase === undefined) throw new Error('fixture 缺少答案')
    // 越出证据区间（charEnd + 1）才算没有覆盖；子区间由下一条用例证明是合法的。
    const badCitation: KnowledgeAnswerResponse = {
      ...answerBase,
      citations: answerBase.citations.map((item) => ({ ...item, charEnd: item.charEnd + 1 })),
    }
    const citationPort = verified(
      createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: badCitation }],
        queries: [],
      }),
    )
    expect((await citationPort.answer(ANSWER_REQUEST)).kind).toBe('refusal')

    const unknown: KnowledgeAnswerResponse = {
      ...answerBase,
      evidence: answerBase.evidence.map((item) => ({ ...item, docId: 'UNKNOWN' })),
      citations: [],
    }
    const unknownPort = verified(
      createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: unknown }],
        queries: [],
      }),
    )
    expect((await unknownPort.answer(ANSWER_REQUEST)).kind).toBe('refusal')

    const noEvidence: KnowledgeAnswerResponse = {
      ...answerBase,
      evidence: [],
      citations: [],
    }
    const emptyPort = verified(
      createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: noEvidence }],
        queries: [],
      }),
    )
    expect((await emptyPort.answer(ANSWER_REQUEST)).kind).toBe('refusal')
  })

  it('引用是已签名证据的子区间 → 放行（真实 sidecar 的形状）', async () => {
    const base = fixture.answers[0]?.response
    const evidence = base?.evidence[0]
    if (base === undefined || evidence === undefined) throw new Error('fixture 缺少答案证据')
    // live sidecar：evidence 是整段 chunk（0–77），citation 只指费率那一句（20–36）。
    const subSpan: KnowledgeAnswerResponse = {
      ...base,
      citations: base.citations.map((item) => ({
        ...item,
        charStart: evidence.charStart + 10,
        charEnd: evidence.charEnd - 10,
      })),
    }
    const port = verified(
      createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: subSpan }],
        queries: [],
      }),
    )

    const response = await port.answer(ANSWER_REQUEST)
    expect(response.kind).toBe('answer')
    expect(response.reasonCode).toBeNull()
  })

  it('引用 marker 与证据不一致 → 拒答（同文档另一条已签名 chunk 不能替它背书）', async () => {
    const base = fixture.answers[0]?.response
    const evidence = base?.evidence[0]
    if (base === undefined || evidence === undefined) throw new Error('fixture 缺少答案证据')
    // 区间合法（落在 evidence 内），但 marker 改了：sidecar 用 marker 把引用绑到具体 chunk。
    const wrongMarker: KnowledgeAnswerResponse = {
      ...base,
      citations: base.citations.map((item) => ({
        ...item,
        marker: 'K9',
        charStart: evidence.charStart + 10,
        charEnd: evidence.charEnd - 10,
      })),
    }
    const rejections: unknown[] = []
    const port = createVerifiedKnowledgePort({
      port: createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: wrongMarker }],
        queries: [],
      }),
      entries: fixtureEntries,
      key: KEY,
      onRejected: (info) => rejections.push(info),
    })

    const response = await port.answer(ANSWER_REQUEST)
    expect(response.kind).toBe('refusal')
    expect(response.reasonCode).toBe('signature-invalid')
    expect((rejections[0] as { detail: string }).detail).toContain('引用')
  })

  it('零长度引用 → 拒答（引用必须覆盖至少一个字符）', async () => {
    const base = fixture.answers[0]?.response
    const evidence = base?.evidence[0]
    if (base === undefined || evidence === undefined) throw new Error('fixture 缺少答案证据')
    const emptySpan: KnowledgeAnswerResponse = {
      ...base,
      citations: base.citations.map((item) => ({
        ...item,
        charStart: evidence.charStart + 1,
        charEnd: evidence.charStart + 1,
      })),
    }
    const port = verified(
      createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: emptySpan }],
        queries: [],
      }),
    )

    const response = await port.answer(ANSWER_REQUEST)
    expect(response.kind).toBe('refusal')
    expect(response.reasonCode).toBe('signature-invalid')
  })

  it('跨来源不可混用：corpus 模式不认 fixture 的 chunkId', async () => {
    const corpusEntries = manifest.entries.filter((entry) => entry.source === 'corpus')
    const port = createVerifiedKnowledgePort({
      port: createFixtureKnowledgePort({ answers: fixture.answers, queries: fixture.queries }),
      entries: corpusEntries,
      key: KEY,
    })
    const response = await port.answer(ANSWER_REQUEST)
    expect(response.kind).toBe('refusal')
    expect(response.reasonCode).toBe('signature-invalid')
  })

  it('refusal 原样透传（服务端已拒答时不再二次包装）', async () => {
    const refusal = fixture.answers.find((item) => item.response.kind === 'refusal')?.response
    if (refusal === undefined) throw new Error('fixture 缺少拒答样本')
    const port = verified(
      createFixtureKnowledgePort({ answers: [{ match: 'VIP', response: refusal }], queries: [] }),
    )
    const response = await port.answer({ ...ANSWER_REQUEST, query: 'VIP 专属费率' })
    expect(response).toEqual(refusal)
  })

  it('摘要对得上但条目 HMAC 被替换 → 仍拒答（签名不是只看 sha256）', async () => {
    const base = fixture.answers[0]?.response
    const evidence = base?.evidence[0]
    if (base === undefined || evidence === undefined) throw new Error('fixture 缺少答案证据')
    const forged: ManifestEntry = {
      source: 'fixture',
      docId: evidence.docId,
      chunkId: evidence.chunkId,
      textSha256: sha256Hex(evidence.text),
      hmac: '0'.repeat(64),
    }
    const rejections: unknown[] = []
    const port = createVerifiedKnowledgePort({
      port: createFixtureKnowledgePort({
        answers: [{ match: '稳盈90天', response: base }],
        queries: [],
      }),
      entries: [forged],
      key: KEY,
      onRejected: (info) => rejections.push(info),
    })

    const response = await port.answer(ANSWER_REQUEST)

    expect(response.kind).toBe('refusal')
    expect(response.reasonCode).toBe('signature-invalid')
    expect(rejections).toHaveLength(1)
    expect((rejections[0] as { detail: string }).detail).toContain('HMAC')
  })

  it('query 没有证据 → 拒答（空检索结果不能当权威依据）', async () => {
    const queryBase = fixture.queries[0]?.response
    if (queryBase === undefined) throw new Error('fixture 缺少 query')
    const empty: KnowledgeQueryResponse = { ...queryBase, evidence: [], values: [] }
    const port = verified(
      createFixtureKnowledgePort({ answers: [], queries: [{ match: '稳盈90天', response: empty }] }),
    )

    const response = await port.query(QUERY_REQUEST)

    expect(response.kind).toBe('refusal')
    expect(response.reasonCode).toBe('signature-invalid')
    expect(response.evidence).toEqual([])
    expect(response.values).toEqual([])
  })

  it('health 原样透传（验签层不改写健康检查语义）', async () => {
    const port = verified(createFixtureKnowledgePort({ answers: [], queries: [] }))
    await expect(port.health()).resolves.toEqual(fixture.health)
  })

  it('missingEntryFor：条目存在但摘要对不上 → 仍判为缺签名', () => {
    const evidence = fixture.answers[0]?.response.evidence[0]
    if (evidence === undefined) throw new Error('fixture 缺少答案证据')
    const entry = manifest.entries.find(
      (item) => item.source === 'fixture' && item.docId === evidence.docId && item.chunkId === evidence.chunkId,
    )
    if (entry === undefined) throw new Error('fixture 缺少签名条目')

    expect(missingEntryFor([entry], [evidence])).toBeUndefined()
    expect(missingEntryFor([entry], [{ ...evidence, text: '伪造的费率 0.00%。' }])).toEqual({
      docId: evidence.docId,
      chunkId: evidence.chunkId,
    })
  })
})
