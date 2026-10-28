/**
 * 监管证据包（W15）：`events.jsonl` / `decisions.md` / `tickets.md` + `manifest.json`。
 *
 * 输入是**独立重放的结果**（`@bah/persistence` 的 `ReplayResult`），本模块只负责落盘、
 * 摘要与离线校验；不启动 Agent、不读运行时。
 *
 * `manifest.json` 给每个文件的 sha256 / 字节数 / 条数；校验只需要 manifest + 文件本身。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReplayResult } from '@bah/persistence'

/** 证据包 schema。 */
export const SESSION_EVIDENCE_SCHEMA = 'session-evidence.v1'

/** manifest 里的一个文件。 */
export interface EvidenceFileEntry {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly count: number
}

/** manifest。 */
export interface SessionEvidenceManifest {
  readonly schemaVersion: string
  readonly episodeId: string
  readonly replay: {
    readonly ok: boolean
    readonly chainOk: boolean
    readonly seqOk: boolean
    readonly diffs: readonly string[]
    readonly warnings: readonly string[]
  }
  readonly files: readonly EvidenceFileEntry[]
}

/** 构建结果。 */
export interface SessionEvidencePack {
  readonly manifest: SessionEvidenceManifest
  readonly dir: string
  readonly paths: readonly string[]
}

/** 三件套文件名（顺序即 manifest 顺序）。 */
export const EVIDENCE_FILES = ['events.jsonl', 'decisions.md', 'tickets.md'] as const

/** 落盘三件套 + manifest。 */
export function buildSessionEvidencePack(options: {
  readonly replay: ReplayResult
  readonly outDir: string
}): SessionEvidencePack {
  const { replay, outDir } = options
  mkdirSync(outDir, { recursive: true })

  const eventsText = replay.events.map((event) => JSON.stringify(event)).join('\n')
  const events = `${eventsText}${eventsText.length === 0 ? '' : '\n'}`
  const decisions = renderDecisions(replay.decisions)
  const tickets = renderTickets(replay.tickets)

  const files: Record<(typeof EVIDENCE_FILES)[number], string> = {
    'events.jsonl': events,
    'decisions.md': decisions,
    'tickets.md': tickets,
  }
  const entries: EvidenceFileEntry[] = []
  for (const name of EVIDENCE_FILES) {
    const text = files[name]
    const path = join(outDir, name)
    writeFileSync(path, text, 'utf8')
    entries.push({
      path: name,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      count:
        name === 'events.jsonl'
          ? replay.events.length
          : name === 'decisions.md'
            ? replay.decisions.length
            : replay.tickets.length,
    })
  }

  const manifest: SessionEvidenceManifest = {
    schemaVersion: SESSION_EVIDENCE_SCHEMA,
    episodeId: replay.sessionId,
    replay: {
      ok: replay.ok,
      chainOk: replay.chain.ok,
      seqOk: replay.seqOk,
      diffs: [...replay.diffs],
      warnings: [...replay.warnings],
    },
    files: entries,
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return {
    manifest,
    dir: outDir,
    paths: [...EVIDENCE_FILES, 'manifest.json'],
  }
}

/** 离线校验：只读 manifest + 文件，不启动任何服务。 */
export function verifySessionEvidencePack(packDir: string): {
  readonly ok: boolean
  readonly findings: readonly string[]
} {
  const findings: string[] = []
  const manifestPath = join(packDir, 'manifest.json')
  if (!existsSync(manifestPath)) return { ok: false, findings: ['manifest.json 缺失'] }
  let manifest: SessionEvidenceManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SessionEvidenceManifest
  } catch {
    return { ok: false, findings: ['manifest.json 不是合法 JSON'] }
  }
  if (manifest.schemaVersion !== SESSION_EVIDENCE_SCHEMA) {
    findings.push(`manifest.schemaVersion 不是 ${SESSION_EVIDENCE_SCHEMA}`)
  }
  const names = new Set(manifest.files.map((entry) => entry.path))
  for (const name of EVIDENCE_FILES) {
    if (!names.has(name)) findings.push(`manifest 缺少文件条目：${name}`)
  }
  for (const entry of manifest.files) {
    const path = join(packDir, entry.path)
    if (!existsSync(path)) {
      findings.push(`文件缺失：${entry.path}`)
      continue
    }
    const text = readFileSync(path, 'utf8')
    if (sha256(text) !== entry.sha256) findings.push(`sha256 不匹配：${entry.path}`)
    if (Buffer.byteLength(text, 'utf8') !== entry.bytes) findings.push(`字节数不匹配：${entry.path}`)
    const count =
      entry.path === 'events.jsonl'
        ? text.split('\n').filter((line) => line.trim().length > 0).length
        : entry.path === 'decisions.md' || entry.path === 'tickets.md'
          ? Math.max(0, text.split('\n').filter((line) => line.startsWith('| ')).length - 1)
          : 0
    if (count !== entry.count) findings.push(`条数不匹配：${entry.path}（manifest ${String(entry.count)} / 实际 ${String(count)}）`)
  }
  return { ok: findings.length === 0, findings }
}

function renderDecisions(decisions: ReplayResult['decisions']): string {
  const lines = [
    '# 判决表（来自审计链）',
    '',
    '| seq | 类型 | 判决 | 主体 | 策略版本 | at |',
    '|---|---|---|---|---|---|',
  ]
  for (const item of decisions) {
    lines.push(
      `| ${String(item.seq)} | ${item.type} | ${item.decision ?? '-'} | ${item.subject ?? '-'} | ${item.policyVersion ?? '-'} | ${String(item.at)} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

function renderTickets(tickets: ReplayResult['tickets']): string {
  const lines = [
    '# 票据表（来自会话 ticket/* 事件）',
    '',
    '| ticketId | callId | 工具 | 终态 | 事件序号 | 理由 |',
    '|---|---|---|---|---|---|',
  ]
  for (const item of tickets) {
    lines.push(
      `| ${item.ticketId} | ${item.callId} | ${item.name} | ${item.status} | ${item.events.join(',')} | ${item.reason ?? '-'} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
