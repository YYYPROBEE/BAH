/**
 * 知识库签名清单生成 / 一致性检查（W06）。
 *
 * 用法：
 * ```bash
 * # 生成（需要 BAH_KNOWLEDGE_KEY；从现有 corpus.json + headless.json 重新签名）
 * pnpm knowledge:sign
 *
 * # CI / 门禁：只检查，不改文件
 * pnpm knowledge:sign --check
 *
 * # 从 RAG 的 SQLite 重新导出语料索引后再签名（开发机；数据库不入库）
 * pnpm knowledge:sign --from-sqlite
 * ```
 *
 * 诚实边界：HMAC 是对称密钥。演示/CI 用公开的 `demo-key-not-for-prod`；
 * 生产必须注入独立密钥并重新签名（无 KMS/HSM，见 docs/deploy.md §3.1）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import {
  KNOWLEDGE_CORPUS_SCHEMA,
  buildManifest,
  collectFixtureEntries,
  loadManifest,
  parseCorpus,
  requireKnowledgeKey,
  verifyManifest,
} from '../packages/knowledge/src/sign.ts'
import { missingEntryFor } from '../packages/knowledge/src/verify-port.ts'
import type { EntryInput, KnowledgeCorpusFile } from '../packages/knowledge/src/sign.ts'

import { projectRoot } from './gate-lib.ts'

const requireForSqlite = createRequire(import.meta.url)

const root = projectRoot()
const CORPUS_PATH = 'packages/knowledge/fixtures/corpus.json'
const FIXTURE_PATH = 'packages/knowledge/fixtures/headless.json'
const MANIFEST_PATH = 'packages/knowledge/fixtures/knowledge.manifest.json'
const SQLITE_PATH = 'services/rag/data/knowledge.sqlite'

const checkOnly = process.argv.includes('--check')
const fromSqlite = process.argv.includes('--from-sqlite')

if (fromSqlite) {
  exportCorpusFromSqlite()
}
if (checkOnly) {
  check()
} else {
  sign()
}

/** 从 RAG 的 SQLite 导出 10 篇语料索引（开发机专用；数据库未入库）。 */
function exportCorpusFromSqlite(): void {
  const dbPath = resolve(root, SQLITE_PATH)
  if (!existsSync(dbPath)) {
    console.error(`✘ ${SQLITE_PATH} 不存在：先跑 pnpm rag:ingest（本命令只在开发机用）`)
    process.exitCode = 1
    return
  }
  // 动态加载：node:sqlite 在 Node 22 仍标记实验特性，只有本脚本会触发告警。
  const sqlite = requireForSqlite('node:sqlite') as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
      prepare: (sql: string) => { all: () => readonly Record<string, unknown>[] }
      close: () => void
    }
  }
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db
      .prepare(
        'SELECT c.doc_id AS doc_id, c.chunk_id AS chunk_id, d.title AS title, c.text AS text ' +
          'FROM chunks c JOIN docs d ON d.doc_id = c.doc_id ' +
          'ORDER BY c.doc_id, c.chunk_id',
      )
      .all()
    const corpus: KnowledgeCorpusFile = {
      schemaVersion: KNOWLEDGE_CORPUS_SCHEMA,
      docs: rows.map((row) => ({
        docId: String(row['doc_id']),
        chunkId: Number(row['chunk_id']),
        title: String(row['title']),
        text: String(row['text']),
      })),
    }
    writeFileSync(resolve(root, CORPUS_PATH), `${JSON.stringify(corpus, null, 2)}\n`, 'utf8')
    console.log(`✔ 已从 SQLite 导出 ${corpus.docs.length} 条语料到 ${CORPUS_PATH}`)
  } finally {
    db.close()
  }
}

/** 生成清单。 */
function sign(): void {
  const key = requireKnowledgeKey()
  const corpus = readCorpus()
  const fixtureText = readText(FIXTURE_PATH)
  const entries: EntryInput[] = [
    ...corpus.docs.map((doc) => ({
      source: 'corpus' as const,
      docId: doc.docId,
      chunkId: doc.chunkId,
      text: doc.text,
    })),
    ...collectFixtureEntries(JSON.parse(fixtureText)),
  ].sort(compareEntries)
  const manifest = buildManifest({
    key,
    signedAt: new Date().toISOString(),
    files: [
      { path: CORPUS_PATH, bytes: readFileSync(resolve(root, CORPUS_PATH)) },
      { path: FIXTURE_PATH, bytes: readFileSync(resolve(root, FIXTURE_PATH)) },
    ],
    entries,
  })
  writeFileSync(
    resolve(root, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  console.log(
    `✔ 已生成 ${MANIFEST_PATH}：文件 ${String(manifest.files.length)} 个、条目 ${String(
      manifest.entries.length,
    )} 条（keyId=${manifest.keyId}）`,
  )
}

/** 一致性检查（CI / 门禁）：不改任何文件，只报错。 */
function check(): void {
  const key = requireKnowledgeKey()
  const manifest = loadManifest(root, MANIFEST_PATH)
  try {
    verifyManifest({
      root,
      manifest,
      key,
      requiredFiles: [CORPUS_PATH, FIXTURE_PATH],
    })
  } catch (error) {
    console.error(`✘ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }

  const corpus = readCorpus()
  const fixtureEntries = collectFixtureEntries(JSON.parse(readText(FIXTURE_PATH)))
  const corpusMissing = missingEntryFor(
    manifest.entries.filter((entry) => entry.source === 'corpus'),
    corpus.docs,
  )
  const fixtureMissing = missingEntryFor(
    manifest.entries.filter((entry) => entry.source === 'fixture'),
    fixtureEntries,
  )
  if (corpusMissing !== undefined || fixtureMissing !== undefined) {
    const missing = corpusMissing ?? fixtureMissing
    console.error(
      `✘ 清单与语料不同步：${String(missing?.docId)}#${String(missing?.chunkId)} 没有签名条目；` +
        '请运行 pnpm knowledge:sign 重新签名',
    )
    process.exitCode = 1
    return
  }
  console.log(
    `✔ 知识库签名一致：${String(corpus.docs.length)} 条语料、${String(
      fixtureEntries.length,
    )} 条 fixture 证据（keyId=${manifest.keyId}）`,
  )
}

function readCorpus(): KnowledgeCorpusFile {
  return parseCorpus(readText(CORPUS_PATH), CORPUS_PATH)
}

function readText(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

function compareEntries(left: EntryInput, right: EntryInput): number {
  const leftKey = `${left.source}#${left.docId}#${String(left.chunkId).padStart(8, '0')}`
  const rightKey = `${right.source}#${right.docId}#${String(right.chunkId).padStart(8, '0')}`
  return leftKey.localeCompare(rightKey)
}
