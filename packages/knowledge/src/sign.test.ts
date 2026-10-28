/**
 * W06 签名清单：生成 / 校验 / 自愈（TC-W06-01、03、04、05、07）。
 *
 * 运行时逐条验签在 `verify-port.test.ts`（TC-02、06、08）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildManifest,
  collectFixtureEntries,
  entryHmacInput,
  hmacHex,
  loadManifest,
  parseCorpus,
  parseManifest,
  requireKnowledgeKey,
  sha256Hex,
  verifyManifest,
} from './sign.ts'
import { missingEntryFor } from './verify-port.ts'
import type { KnowledgeManifest } from './sign.ts'

const ROOT = process.cwd()
const CORPUS_PATH = 'packages/knowledge/fixtures/corpus.json'
const FIXTURE_PATH = 'packages/knowledge/fixtures/headless.json'
const MANIFEST_PATH = 'packages/knowledge/fixtures/knowledge.manifest.json'
const KEY = requireKnowledgeKey()
const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-w06-'))
  scratch.push(dir)
  return dir
}

describe('W06 · 清单校验', () => {
  it('TC-W06-01 10 篇 / 10 chunks 全部验签通过，fixture 证据条目齐全', () => {
    const manifest = loadManifest(ROOT, MANIFEST_PATH)
    expect(() =>
      verifyManifest({
        root: ROOT,
        manifest,
        key: KEY,
        requiredFiles: [CORPUS_PATH, FIXTURE_PATH],
      }),
    ).not.toThrow()

    const corpus = parseCorpus(readFileSync(join(ROOT, CORPUS_PATH), 'utf8'), CORPUS_PATH)
    expect(corpus.docs).toHaveLength(10)
    const corpusEntries = manifest.entries.filter((entry) => entry.source === 'corpus')
    expect(corpusEntries).toHaveLength(10)
    expect(missingEntryFor(corpusEntries, corpus.docs)).toBeUndefined()

    const fixture = JSON.parse(readFileSync(join(ROOT, FIXTURE_PATH), 'utf8')) as {
      health: { docs: number; chunks: number }
    }
    expect(fixture.health).toMatchObject({ docs: 10, chunks: 10 })

    const fixtureEntries = collectFixtureEntries(fixture)
    expect(fixtureEntries.length).toBeGreaterThan(0)
    expect(
      missingEntryFor(
        manifest.entries.filter((entry) => entry.source === 'fixture'),
        fixtureEntries,
      ),
    ).toBeUndefined()
  })

  it('TC-W06-03 清单缺失 → 载入即抛（不是静默降级）', () => {
    try {
      loadManifest(ROOT, 'packages/knowledge/fixtures/no-such-manifest.json')
      throw new Error('应当抛出')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('knowledge-signature-manifest-missing')
      expect((error as Error).message).toContain('no-such-manifest.json')
    }
  })

  it('TC-W06-05 密钥缺失 → fail-loud（无默认密钥）', () => {
    try {
      requireKnowledgeKey({})
      throw new Error('应当抛出')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('knowledge-signature-key-missing')
      expect((error as Error).message).toContain('BAH_KNOWLEDGE_KEY')
    }
    expect(() => requireKnowledgeKey({ BAH_KNOWLEDGE_KEY: '   ' })).toThrow(
      /BAH_KNOWLEDGE_KEY/,
    )
  })

  it('TC-W06-04 文件 sha256 不匹配 → 失败信息点名文件', () => {
    const dir = tempDir()
    const v1 = Buffer.from('{"schemaVersion":"knowledge-corpus.v1","docs":[]}', 'utf8')
    writeFileSync(join(dir, 'corpus.json'), v1)
    const manifest = buildManifest({
      key: KEY,
      signedAt: '2026-10-26T00:00:00.000Z',
      files: [{ path: 'corpus.json', bytes: v1 }],
      entries: [],
    })
    writeFileSync(join(dir, 'knowledge.manifest.json'), JSON.stringify(manifest), 'utf8')
    verifyManifest({
      root: dir,
      manifest: loadManifest(dir, 'knowledge.manifest.json'),
      key: KEY,
      requiredFiles: ['corpus.json'],
    })

    writeFileSync(join(dir, 'corpus.json'), Buffer.from('{"schemaVersion":"knowledge-corpus.v1","docs":[]} ', 'utf8'))
    try {
      verifyManifest({
        root: dir,
        manifest: loadManifest(dir, 'knowledge.manifest.json'),
        key: KEY,
        requiredFiles: ['corpus.json'],
      })
      throw new Error('应当抛出')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('knowledge-signature-mismatch')
      expect((error as Error).message).toContain('corpus.json')
    }
  })

  it('TC-W06-07 清单与语料不同步 → 重新签名后恢复（自愈路径）', () => {
    const dir = tempDir()
    const v1 = Buffer.from('v1', 'utf8')
    writeFileSync(join(dir, 'corpus.json'), v1)
    const first = buildManifest({
      key: KEY,
      signedAt: '2026-10-26T00:00:00.000Z',
      files: [{ path: 'corpus.json', bytes: v1 }],
      entries: [],
    })
    writeFileSync(join(dir, 'knowledge.manifest.json'), JSON.stringify(first), 'utf8')

    writeFileSync(join(dir, 'corpus.json'), Buffer.from('v2', 'utf8'))
    expect(() =>
      verifyManifest({
        root: dir,
        manifest: loadManifest(dir, 'knowledge.manifest.json'),
        key: KEY,
        requiredFiles: ['corpus.json'],
      }),
    ).toThrow(/corpus\.json/)

    const v2 = readFileSync(join(dir, 'corpus.json'))
    const second = buildManifest({
      key: KEY,
      signedAt: '2026-10-26T00:01:00.000Z',
      files: [{ path: 'corpus.json', bytes: v2 }],
      entries: [],
    })
    writeFileSync(join(dir, 'knowledge.manifest.json'), JSON.stringify(second), 'utf8')
    expect(() =>
      verifyManifest({
        root: dir,
        manifest: loadManifest(dir, 'knowledge.manifest.json'),
        key: KEY,
        requiredFiles: ['corpus.json'],
      }),
    ).not.toThrow()
  })

  it('对抗：改条目 HMAC / 换密钥 / 改条目摘要 都会被拒', () => {
    const manifest = loadManifest(ROOT, MANIFEST_PATH)
    const tamperedHmac: KnowledgeManifest = {
      ...manifest,
      entries: manifest.entries.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              hmac: `${entry.hmac.slice(0, -1)}${entry.hmac.endsWith('0') ? '1' : '0'}`,
            }
          : entry,
      ),
    }
    expect(() =>
      verifyManifest({
        root: ROOT,
        manifest: tamperedHmac,
        key: KEY,
        requiredFiles: [CORPUS_PATH],
      }),
    ).toThrow(/条目签名不匹配/)

    expect(() =>
      verifyManifest({
        root: ROOT,
        manifest,
        key: 'another-key',
        requiredFiles: [CORPUS_PATH],
      }),
    ).toThrow(/不匹配/)

    const tamperedDigest: KnowledgeManifest = {
      ...manifest,
      entries: manifest.entries.map((entry, index) =>
        index === 0 ? { ...entry, textSha256: sha256Hex('forged') } : entry,
      ),
    }
    expect(() =>
      verifyManifest({
        root: ROOT,
        manifest: tamperedDigest,
        key: KEY,
        requiredFiles: [CORPUS_PATH],
      }),
    ).toThrow(/条目签名不匹配/)
  })

  it('buildManifest 条目签名 = hmac(来源#docId#chunkId#sha256(text))', () => {
    const dir = tempDir()
    const bytes = Buffer.from('{"schemaVersion":"knowledge-corpus.v1","docs":[]}', 'utf8')
    writeFileSync(join(dir, 'corpus.json'), bytes)
    const manifest = buildManifest({
      key: KEY,
      signedAt: '2026-10-26T00:00:00.000Z',
      files: [{ path: 'corpus.json', bytes }],
      entries: [{ source: 'corpus', docId: 'doc-1', chunkId: 2, text: '赎回费率 1.50%' }],
    })

    const digest = sha256Hex('赎回费率 1.50%')
    expect(manifest.entries[0]).toEqual({
      source: 'corpus',
      docId: 'doc-1',
      chunkId: 2,
      textSha256: digest,
      hmac: hmacHex(KEY, entryHmacInput('corpus', 'doc-1', 2, digest)),
    })
    expect(() =>
      verifyManifest({ root: dir, manifest, key: KEY, requiredFiles: ['corpus.json'] }),
    ).not.toThrow()
  })

  it('parseManifest：非法 JSON / 顶层非对象 / 形状越界全部 fail-loud', () => {
    expect(() => parseManifest('not-json', 'm.json')).toThrow(/不是合法 JSON/)
    expect(() => parseManifest('[]', 'm.json')).toThrow(/顶层必须是对象/)

    const base = {
      schemaVersion: 'knowledge-manifest.v1',
      keyId: 'kid',
      signedAt: '2026-10-26T00:00:00.000Z',
      files: [],
      entries: [],
    }
    expect(() => parseManifest(JSON.stringify({ ...base, files: 'nope' }), 'm.json')).toThrow(
      /必须是数组/,
    )
    expect(() =>
      parseManifest(
        JSON.stringify({
          ...base,
          entries: [{ source: 'web', docId: 'd', chunkId: 1, textSha256: 'x', hmac: 'y' }],
        }),
        'm.json',
      ),
    ).toThrow(/corpus \/ fixture/)
    expect(() =>
      parseManifest(
        JSON.stringify({
          ...base,
          entries: [{ source: 'corpus', docId: 'd', chunkId: 1.5, textSha256: 'x', hmac: 'y' }],
        }),
        'm.json',
      ),
    ).toThrow(/整数/)
    expect(() => parseManifest(JSON.stringify({ ...base, schemaVersion: 'v2' }), 'm.json')).toThrow(
      /schemaVersion/,
    )
    expect(() => parseManifest(JSON.stringify({ ...base, files: [1] }), 'm.json')).toThrow(
      /必须是对象/,
    )
    expect(() =>
      parseManifest(
        JSON.stringify({
          ...base,
          entries: [{ source: 'corpus', docId: '', chunkId: 1, textSha256: 'x', hmac: 'y' }],
        }),
        'm.json',
      ),
    ).toThrow(/必须是非空字符串/)
  })

  it('collectFixtureEntries：跨 answers / queries 去重并按 docId#chunkId 排序', () => {
    const entries = collectFixtureEntries({
      answers: [
        {
          response: {
            evidence: [
              { docId: 'Z', chunkId: 2, text: 'b' },
              { docId: 'A', chunkId: 1, text: 'a' },
              { docId: 'A', chunkId: 1, text: 'a' },
            ],
          },
        },
      ],
      queries: [
        { response: { evidence: [{ docId: 'B', chunkId: 1, text: 'c' }] } },
      ],
    })

    expect(entries.map((entry) => `${entry.docId}#${String(entry.chunkId)}`)).toEqual([
      'A#1',
      'B#1',
      'Z#2',
    ])
  })

  it('parseCorpus：非法 JSON / 版本不符 / chunkId 非整数全部 fail-loud', () => {
    expect(() => parseCorpus('{', 'c.json')).toThrow(/不是合法 JSON/)
    expect(() => parseCorpus(JSON.stringify({ schemaVersion: 'v2', docs: [] }), 'c.json')).toThrow(
      /schemaVersion/,
    )
    expect(() =>
      parseCorpus(
        JSON.stringify({
          schemaVersion: 'knowledge-corpus.v1',
          docs: [{ docId: 'd', chunkId: 0.5, title: 't', text: 'x' }],
        }),
        'c.json',
      ),
    ).toThrow(/整数/)
  })

  it('verifyManifest：缺文件条目 / 文件不存在 / 文件 HMAC 被替换都会拒', () => {
    const dir = tempDir()
    const bytes = Buffer.from('corpus-v1', 'utf8')
    writeFileSync(join(dir, 'corpus.json'), bytes)
    const manifest = buildManifest({
      key: KEY,
      signedAt: '2026-10-26T00:00:00.000Z',
      files: [{ path: 'corpus.json', bytes }],
      entries: [],
    })

    expect(() =>
      verifyManifest({ root: dir, manifest: { ...manifest, files: [] }, key: KEY, requiredFiles: ['corpus.json'] }),
    ).toThrow(/缺少文件条目/)

    expect(() =>
      verifyManifest({
        root: dir,
        manifest: { ...manifest, schemaVersion: 'knowledge-manifest.v2' },
        key: KEY,
        requiredFiles: ['corpus.json'],
      }),
    ).toThrow(/schemaVersion/)

    const ghost = buildManifest({
      key: KEY,
      signedAt: '2026-10-26T00:00:00.000Z',
      files: [{ path: 'ghost.json', bytes }],
      entries: [],
    })
    expect(() =>
      verifyManifest({ root: dir, manifest: ghost, key: KEY, requiredFiles: ['ghost.json'] }),
    ).toThrow(/文件不存在/)

    const forged: KnowledgeManifest = {
      ...manifest,
      files: manifest.files.map((entry) => ({ ...entry, hmac: '0'.repeat(64) })),
    }
    expect(() =>
      verifyManifest({ root: dir, manifest: forged, key: KEY, requiredFiles: ['corpus.json'] }),
    ).toThrow(/文件签名不匹配/)
  })
})
