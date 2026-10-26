/**
 * 权威知识库签名门（W06）：语料清单签名 + 条目验签。
 *
 * 机制（**HMAC-SHA256**，密钥来自 `BAH_KNOWLEDGE_KEY`，无硬编码默认值）：
 * - 文件级：`sha256(bytes)` + `hmac(path + "\n" + sha256)` —— 启动时校验语料未被整体替换；
 * - 条目级：`sha256(text)` + `hmac(docId#chunkId#sha256)` —— 每次检索命中逐条验签。
 *
 * 为什么两级都要：文件级能发现"改了语料忘记重签"，但 HTTP sidecar 返回的是**远端内容**；
 * 只有条目级签名才能证明"服务端给的这一条确实是我方签名过的那一条"（服务端被替换 /
 * 配置漂移都不会让本地验签失效）。
 *
 * 诚实边界（写进 `docs/deploy.md`）：HMAC 是对称密钥，演示/CI 用公开的
 * `demo-key-not-for-prod`；生产必须注入独立密钥并重新签名。无 KMS/HSM。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { BahError } from '@bah/util'

/** 清单 schema（改形状必须升版本）。 */
export const KNOWLEDGE_MANIFEST_SCHEMA = 'knowledge-manifest.v1'
/** 语料索引 schema。 */
export const KNOWLEDGE_CORPUS_SCHEMA = 'knowledge-corpus.v1'
/** 密钥环境变量名（唯一来源）。 */
export const KNOWLEDGE_KEY_ENV = 'BAH_KNOWLEDGE_KEY'
/** 验签失败的理由码（`knowledge/answered.reasonCode` 复用这个值）。 */
export const SIGNATURE_INVALID_CODE = 'signature-invalid'

/** 语料索引里的一条（一个 chunk）。 */
export interface CorpusDoc {
  readonly docId: string
  readonly chunkId: number
  readonly title: string
  readonly text: string
}

/** `knowledge.corpus.json` 的形状。 */
export interface KnowledgeCorpusFile {
  readonly schemaVersion: string
  readonly docs: readonly CorpusDoc[]
}

/** 清单的文件级条目（W06 规定的五字段）。 */
export interface ManifestFileEntry {
  readonly path: string
  readonly sha256: string
  readonly hmac: string
  readonly keyId: string
  readonly signedAt: string
}

/** 条目来源：正式语料 / fixture（演示夹具）。 */
export type ManifestEntrySource = 'corpus' | 'fixture'

/** 清单的条目级签名。 */
export interface ManifestEntry {
  readonly source: ManifestEntrySource
  readonly docId: string
  readonly chunkId: number
  readonly textSha256: string
  readonly hmac: string
}

/** `knowledge.manifest.json` 的形状。 */
export interface KnowledgeManifest {
  readonly schemaVersion: string
  readonly keyId: string
  readonly signedAt: string
  readonly files: readonly ManifestFileEntry[]
  readonly entries: readonly ManifestEntry[]
}

/** 待签名条目（还没有 hmac）。 */
export interface EntryInput {
  readonly source: ManifestEntrySource
  readonly docId: string
  readonly chunkId: number
  readonly text: string
}

/** sha256（hex，小写）。 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 密钥 ID（从密钥派生；只用于"用错钥匙"的早失败，不是秘密）。 */
export function keyIdOf(key: string): string {
  return `kid-${sha256Hex(key).slice(0, 12)}`
}

/** 从环境变量取密钥；缺失/空白即抛（不许默认密钥）。 */
export function requireKnowledgeKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[KNOWLEDGE_KEY_ENV]
  if (key === undefined || key.trim().length === 0) {
    throw new BahError(
      'knowledge-signature-key-missing',
      `知识库签名密钥缺失：必须显式设置 ${KNOWLEDGE_KEY_ENV}（无 KMS/HSM，密钥来自环境变量；禁止默认密钥）`,
      { env: KNOWLEDGE_KEY_ENV },
    )
  }
  return key
}

/** 文件级 HMAC 输入（路径与内容摘要绑定，换路径也会失效）。 */
export function fileHmacInput(path: string, digest: string): string {
  return `${path}\n${digest}`
}

/** 条目级 HMAC 输入。 */
export function entryHmacInput(source: string, docId: string, chunkId: number, digest: string): string {
  return `${source}#${docId}#${String(chunkId)}#${digest}`
}

/** HMAC-SHA256（hex）。 */
export function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message).digest('hex')
}

/** 恒定时间比较（长度不同直接 false，不抛）。 */
export function digestEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 文件级签名。 */
export function signFileEntry(
  path: string,
  bytes: Uint8Array,
  key: string,
  signedAt: string,
): ManifestFileEntry {
  const digest = sha256Hex(bytes)
  const keyId = keyIdOf(key)
  return {
    path,
    sha256: digest,
    hmac: hmacHex(key, fileHmacInput(path, digest)),
    keyId,
    signedAt,
  }
}

/** 条目级签名。 */
export function signEntry(entry: EntryInput, key: string): ManifestEntry {
  const digest = sha256Hex(entry.text)
  return {
    source: entry.source,
    docId: entry.docId,
    chunkId: entry.chunkId,
    textSha256: digest,
    hmac: hmacHex(key, entryHmacInput(entry.source, entry.docId, entry.chunkId, digest)),
  }
}

/** 组装清单（调用方负责把文件读成 bytes）。 */
export function buildManifest(options: {
  readonly key: string
  readonly signedAt: string
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[]
  readonly entries: readonly EntryInput[]
}): KnowledgeManifest {
  return {
    schemaVersion: KNOWLEDGE_MANIFEST_SCHEMA,
    keyId: keyIdOf(options.key),
    signedAt: options.signedAt,
    files: options.files.map((file) => signFileEntry(file.path, file.bytes, options.key, options.signedAt)),
    entries: options.entries.map((entry) => signEntry(entry, options.key)),
  }
}

/** 解析清单（形状不合法即抛；不静默补默认值）。 */
export function parseManifest(text: string, where: string): KnowledgeManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BahError('knowledge-signature-manifest-invalid', `${where}: 不是合法 JSON`, { where })
  }
  if (!isRecord(parsed)) {
    throw new BahError('knowledge-signature-manifest-invalid', `${where}: 顶层必须是对象`, { where })
  }
  const schemaVersion = readString(parsed['schemaVersion'], `${where}.schemaVersion`)
  const keyId = readString(parsed['keyId'], `${where}.keyId`)
  const signedAt = readString(parsed['signedAt'], `${where}.signedAt`)
  const files = readArray(parsed['files'], `${where}.files`).map((item, index) => {
    const entry = asRecord(item, `${where}.files[${String(index)}]`)
    return {
      path: readString(entry['path'], `${where}.files[${String(index)}].path`),
      sha256: readString(entry['sha256'], `${where}.files[${String(index)}].sha256`),
      hmac: readString(entry['hmac'], `${where}.files[${String(index)}].hmac`),
      keyId: readString(entry['keyId'], `${where}.files[${String(index)}].keyId`),
      signedAt: readString(entry['signedAt'], `${where}.files[${String(index)}].signedAt`),
    }
  })
  const entries = readArray(parsed['entries'], `${where}.entries`).map((item, index) => {
    const entry = asRecord(item, `${where}.entries[${String(index)}]`)
    const sourceValue = readString(entry['source'], `${where}.entries[${String(index)}].source`)
    if (sourceValue !== 'corpus' && sourceValue !== 'fixture') {
      throw new BahError(
        'knowledge-signature-manifest-invalid',
        `${where}.entries[${String(index)}].source 只能是 corpus / fixture`,
        { where },
      )
    }
    const source: ManifestEntrySource = sourceValue
    const chunkId = entry['chunkId']
    if (typeof chunkId !== 'number' || !Number.isInteger(chunkId)) {
      throw new BahError(
        'knowledge-signature-manifest-invalid',
        `${where}.entries[${String(index)}].chunkId 必须是整数`,
        { where },
      )
    }
    return {
      source,
      docId: readString(entry['docId'], `${where}.entries[${String(index)}].docId`),
      chunkId,
      textSha256: readString(entry['textSha256'], `${where}.entries[${String(index)}].textSha256`),
      hmac: readString(entry['hmac'], `${where}.entries[${String(index)}].hmac`),
    }
  })
  if (schemaVersion !== KNOWLEDGE_MANIFEST_SCHEMA) {
    throw new BahError(
      'knowledge-signature-manifest-invalid',
      `${where}.schemaVersion 只支持 ${KNOWLEDGE_MANIFEST_SCHEMA}（收到 ${schemaVersion}）`,
      { where },
    )
  }
  return { schemaVersion, keyId, signedAt, files, entries }
}

/** 解析语料索引（形状不合法即抛）。 */
export function parseCorpus(text: string, where: string): KnowledgeCorpusFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BahError('knowledge-signature-corpus-invalid', `${where}: 不是合法 JSON`, { where })
  }
  const record = asRecord(parsed, where)
  const schemaVersion = readString(record['schemaVersion'], `${where}.schemaVersion`)
  if (schemaVersion !== KNOWLEDGE_CORPUS_SCHEMA) {
    throw new BahError(
      'knowledge-signature-corpus-invalid',
      `${where}.schemaVersion 只支持 ${KNOWLEDGE_CORPUS_SCHEMA}`,
      { where },
    )
  }
  const docs = readArray(record['docs'], `${where}.docs`).map((item, index) => {
    const doc = asRecord(item, `${where}.docs[${String(index)}]`)
    const chunkId = doc['chunkId']
    if (typeof chunkId !== 'number' || !Number.isInteger(chunkId)) {
      throw new BahError(
        'knowledge-signature-corpus-invalid',
        `${where}.docs[${String(index)}].chunkId 必须是整数`,
        { where },
      )
    }
    return {
      docId: readString(doc['docId'], `${where}.docs[${String(index)}].docId`),
      chunkId,
      title: readString(doc['title'], `${where}.docs[${String(index)}].title`),
      text: readString(doc['text'], `${where}.docs[${String(index)}].text`),
    }
  })
  return { schemaVersion, docs }
}

/**
 * 从 fixture 的响应里抽证据条目（签名清单的 fixture 部分）。
 *
 * fixture 的 `text` 是**证据片段**，与正式语料的 chunk 全文可能不同；因此单独作为
 * `source: 'fixture'` 的一组签名，运行时按模式选用，不混用。
 */
export function collectFixtureEntries(fixture: unknown): EntryInput[] {
  const record = asRecord(fixture, 'fixture')
  const entries = new Map<string, EntryInput>()
  const responses: unknown[] = []
  for (const key of ['answers', 'queries'] as const) {
    const list = record[key]
    if (list === undefined) continue
    for (const item of readArray(list, `fixture.${key}`)) {
      const entry = asRecord(item, `fixture.${key}[]`)
      responses.push(entry['response'])
    }
  }
  for (const key of ['defaultAnswer', 'defaultQuery'] as const) {
    const value = record[key]
    if (value !== undefined) responses.push(value)
  }
  for (const response of responses) {
    if (!isRecord(response)) continue
    const evidence = response['evidence']
    if (!Array.isArray(evidence)) continue
    for (const item of evidence) {
      if (!isRecord(item)) continue
      const docId = item['docId']
      const chunkId = item['chunkId']
      const text = item['text']
      if (typeof docId !== 'string' || typeof text !== 'string') continue
      if (typeof chunkId !== 'number' || !Number.isInteger(chunkId)) continue
      entries.set(`${docId}#${String(chunkId)}`, {
        source: 'fixture',
        docId,
        chunkId,
        text,
      })
    }
  }
  return [...entries.values()].sort((left, right) =>
    `${left.docId}#${String(left.chunkId)}`.localeCompare(`${right.docId}#${String(right.chunkId)}`),
  )
}

/**
 * 启动校验：清单 / 密钥 / 文件内容 / 条目签名全部通过才算权威库可用。
 *
 * @throws `BahError`；`err.context.path` 指出出问题的文件（TC-W06-04 要求错误信息点名文件）
 */
export function verifyManifest(options: {
  readonly root: string
  readonly manifest: KnowledgeManifest
  readonly key: string
  readonly requiredFiles: readonly string[]
}): void {
  const { root, manifest, key } = options
  if (manifest.schemaVersion !== KNOWLEDGE_MANIFEST_SCHEMA) {
    throw new BahError(
      'knowledge-signature-manifest-invalid',
      `清单 schemaVersion 只支持 ${KNOWLEDGE_MANIFEST_SCHEMA}`,
    )
  }
  const expectedKeyId = keyIdOf(key)
  if (manifest.keyId !== expectedKeyId) {
    throw new BahError(
      'knowledge-signature-key-mismatch',
      `知识库签名密钥与清单不匹配（清单 keyId=${manifest.keyId}，当前密钥 keyId=${expectedKeyId}）；` +
        '请用当前密钥重新运行 pnpm knowledge:sign',
      { expectedKeyId, manifestKeyId: manifest.keyId },
    )
  }

  for (const path of options.requiredFiles) {
    const entry = manifest.files.find((file) => file.path === path)
    if (entry === undefined) {
      throw new BahError(
        'knowledge-signature-file-missing',
        `签名清单缺少文件条目：${path}（语料未签名或清单过期）`,
        { path },
      )
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(resolve(root, path))
    } catch {
      throw new BahError('knowledge-signature-file-missing', `签名清单指向的文件不存在：${path}`, {
        path,
      })
    }
    const digest = sha256Hex(bytes)
    if (digest !== entry.sha256) {
      throw new BahError(
        'knowledge-signature-mismatch',
        `语料摘要不匹配：${path}（sha256 期望 ${entry.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）；` +
          '语料被修改过，请重新运行 pnpm knowledge:sign',
        { path, expected: entry.sha256, actual: digest },
      )
    }
    if (!digestEquals(entry.hmac, hmacHex(key, fileHmacInput(path, digest)))) {
      throw new BahError(
        'knowledge-signature-mismatch',
        `文件签名不匹配：${path}（清单被替换或签名密钥不一致）`,
        { path },
      )
    }
  }

  for (const entry of manifest.entries) {
    const expected = hmacHex(
      key,
      entryHmacInput(entry.source, entry.docId, entry.chunkId, entry.textSha256),
    )
    if (!digestEquals(entry.hmac, expected)) {
      throw new BahError(
        'knowledge-signature-mismatch',
        `条目签名不匹配：${entry.source}:${entry.docId}#${String(entry.chunkId)}`,
        { docId: entry.docId, chunkId: entry.chunkId },
      )
    }
  }
}

/** 读取并解析清单文件（不存在即抛，不降级）。 */
export function loadManifest(root: string, path: string): KnowledgeManifest {
  let text: string
  try {
    text = readFileSync(resolve(root, path), 'utf8')
  } catch {
    throw new BahError(
      'knowledge-signature-manifest-missing',
      `知识库签名清单不存在：${path}（没有签名清单的权威库等于没有权威库）`,
      { path },
    )
  }
  return parseManifest(text, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BahError('knowledge-signature-manifest-invalid', `${where} 必须是对象`, { where })
  }
  return value
}

function readString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BahError('knowledge-signature-manifest-invalid', `${where} 必须是非空字符串`, { where })
  }
  return value
}

function readArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new BahError('knowledge-signature-manifest-invalid', `${where} 必须是数组`, { where })
  }
  return value
}
