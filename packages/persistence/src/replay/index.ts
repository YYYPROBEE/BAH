/**
 * 独立重放（W15）：只读 `session.jsonl` + `audit.jsonl`，重建
 * `{ 事件序列, 判决表, 票据表 }`，不启动 AgentLoop、不调模型、不调工具。
 *
 * 本模块位于 `@bah/persistence`（读侧投影），**不 import host / cli / runtime / llm / safety**；
 * 门禁 `verify-replay-isolation` 会扫 `scripts/replay.ts` 的传递闭包。
 *
 * 能证明什么：
 * - 链连续性（改/删 `audit.jsonl` 任意一行 → `brokenAt`）；
 * - 链上摘要与会话数据的差异**只作 warning**（会话落盘会脱敏，不能反推原始摘要）；
 * - 会话事件的 `seq` 连续性（删一条会话事件会留下序号空洞）。
 *
 * 不能证明什么（如实登记）：普通 `user/message` 被改写成另一个合法 JSON 且序号不变时，
 * 会话日志本身没有逐行哈希，单靠本模块无法发现；需要 EvidencePack 的 manifest 外部锚定。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SessionEvent } from '@bah/core'
import { canonicalJson, sha256Hex } from '@bah/util'

import { ChainFile } from '../chain/chain-file.ts'
import { verifyChainRows } from '../chain/hash.ts'
import { loadSigningKeys, verifyRecord } from '../chain/sign.ts'
import { JsonlPersistence } from '../jsonl/index.ts'

/** 判决表的一行（来自链上 v2 信封）。 */
export interface ReplayDecision {
  readonly seq: number
  readonly type: string
  readonly decision?: 'allow' | 'deny' | 'ask'
  readonly subject?: string
  readonly policyVersion?: string
  readonly at: number
}

/** 票据表的一行（来自会话 `ticket/*` 领域事件）。 */
export interface ReplayTicket {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly status: string
  readonly events: readonly number[]
  readonly reason?: string
}

/** 重放结果。 */
export interface ReplayResult {
  readonly ok: boolean
  readonly sessionId: string
  readonly events: readonly SessionEvent[]
  readonly decisions: readonly ReplayDecision[]
  readonly tickets: readonly ReplayTicket[]
  readonly chain: { readonly ok: boolean; readonly brokenAt?: number; readonly rows: number }
  readonly seqOk: boolean
  /** 所有不一致（空 = diff=0）。 */
  readonly diffs: readonly string[]
  /** 非致命差异（会话日志脱敏导致 `tool/call` 摘要不可比，见文件头）。 */
  readonly warnings: readonly string[]
}

/** 重放选项。 */
export interface ReplayOptions {
  /** 会话根（`<root>/<sessionId>/session.jsonl` 与 `audit.jsonl`）。 */
  readonly root: string
  readonly sessionId: string
  /** 如需验签，给 Ed25519 私钥路径；缺省只验哈希连续性。 */
  readonly keyPath?: string
}

/** 执行独立重放。 */
export function replaySession(options: ReplayOptions): ReplayResult {
  const dir = join(options.root, options.sessionId)
  const sessionPath = join(dir, 'session.jsonl')
  const diffs: string[] = []
  const warnings: string[] = []

  if (!existsSync(sessionPath)) {
    return {
      ok: false,
      sessionId: options.sessionId,
      events: [],
      decisions: [],
      tickets: [],
      chain: { ok: false, rows: 0 },
      seqOk: false,
      diffs: [`session-missing:${sessionPath}`],
      warnings: [],
    }
  }

  let events: readonly SessionEvent[] = []
  let sessionError: string | undefined
  try {
    const handle = new JsonlPersistence({ fsync: false, redact: false, warn: () => undefined }).open(
      dir,
      { mode: 'read' },
    )
    events = handle.events()
  } catch (error) {
    sessionError = error instanceof Error ? error.message : String(error)
    diffs.push(`session-read-failed:${sessionError}`)
  }

  // 原始行逐条比对：解析结果必须与 reader 给的事件逐字段相同（reader 不静默改写）。
  const rawLines = readFileSync(sessionPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('bah-session-header'))
  if (sessionError === undefined) {
    if (rawLines.length !== events.length) {
      diffs.push(`event-count:raw=${String(rawLines.length)} reader=${String(events.length)}`)
    }
    for (const [index, line] of rawLines.entries()) {
      try {
        const parsed = JSON.parse(line) as unknown
        if (JSON.stringify(parsed) !== JSON.stringify(events[index])) {
          diffs.push(`session-event:${String(index + 1)}`)
        }
      } catch {
        diffs.push(`jsonl-parse:${String(index + 1)}`)
      }
    }
  }

  // seq 连续性：删一条会留下空洞（改内容不会，但链/交叉校验会覆盖链上事件）。
  const seqOk = checkSeq(events, diffs)

  // 链：连续性 + 与链覆盖事件的摘要交叉校验。
  const chainFile = new ChainFile({ rootDir: options.root, fsync: false, warn: () => undefined })
  const chainRows = chainFile.read(options.sessionId)
  let chain: { ok: boolean; brokenAt?: number; rows: number } = {
    ok: true,
    rows: chainRows.length,
  }
  try {
    const continuity = verifyChainRows(chainRows)
    chain = {
      ok: continuity.ok,
      ...(continuity.brokenAt === undefined ? {} : { brokenAt: continuity.brokenAt }),
      rows: chainRows.length,
    }
    if (!continuity.ok) diffs.push(`chain-broken:${String(continuity.brokenAt ?? 0)}`)
    if (options.keyPath !== undefined) {
      const keys = loadSigningKeys(options.keyPath, 'replay-verify', 1)
      let signed = 0
      for (const row of chainRows) {
        if (row.sig === undefined) continue
        signed += 1
        if (!verifyRecord(keys, row.r, row.sig)) diffs.push(`chain-signature:${String(row.q)}`)
      }
      if (signed === 0) diffs.push('chain-unsigned')
    }
  } catch (error) {
    chain = { ok: false, rows: chainRows.length }
    diffs.push(`chain-read-failed:${error instanceof Error ? error.message : String(error)}`)
  }

  // 有链覆盖事件但链为空 → 证据链缺失（不能当作"没有判决"）。
  const covered = events.filter((event) => event.type === 'tool/call' || event.type === 'approval/decided')
  if (covered.length > 0 && chainRows.length === 0) {
    diffs.push('audit-chain-missing')
  }

  // 交叉校验（**只作 warning**）：链上 `d` 是 `sha256(canonicalJson(原始 data))`，
  // 而 `session.jsonl` 落盘前会对 args/票据等做 PII 脱敏；两者不可直接相等。
  // 因此 replay 的硬判据是"链连续 + seq 连续 + 原始行与 reader 逐条一致"，不是摘要相等。
  for (const type of ['tool/call', 'approval/decided'] as const) {
    const sessionDigests = events
      .filter((event) => event.type === type)
      .map((event) => sha256Hex(canonicalJson(event.data)))
    const chainDigests = chainRows.filter((row) => row.t === type).map((row) => row.d)
    if (sessionDigests.length !== chainDigests.length) {
      warnings.push(`cross-check:${type}:count=${String(sessionDigests.length)}/${String(chainDigests.length)}`)
      continue
    }
    for (const [index, digest] of sessionDigests.entries()) {
      if (chainDigests[index] !== digest) {
        warnings.push(`cross-check:${type}:${String(index + 1)}（会话脱敏后不可比，仅提示）`)
      }
    }
  }

  return {
    ok: diffs.length === 0 && chain.ok && seqOk,
    sessionId: options.sessionId,
    events,
    decisions: chainRows.map((row) => ({
      seq: row.q,
      type: row.t,
      ...(row.decision === undefined ? {} : { decision: row.decision }),
      ...(row.subject === undefined ? {} : { subject: row.subject }),
      ...(row.policyVersion === undefined ? {} : { policyVersion: row.policyVersion }),
      at: row.recordedAt,
    })),
    tickets: projectTickets(events, diffs),
    chain,
    seqOk,
    diffs,
    warnings,
  }
}

/** 会话事件 seq 必须严格连续（从首个事件的 seq 起 +1）。 */
function checkSeq(events: readonly SessionEvent[], diffs: string[]): boolean {
  let ok = true
  const first = events[0]
  if (first !== undefined && first.seq !== 1) {
    diffs.push(`seq-start:${String(first.seq)}`)
    ok = false
  }
  for (const [index, event] of events.entries()) {
    const previous = events[index - 1]
    if (previous !== undefined && event.seq !== previous.seq + 1) {
      diffs.push(`seq-gap:${String(event.seq)}`)
      ok = false
    }
  }
  return ok
}

/** `ticket/*` 领域事件 → 票据表（状态机读侧投影）。 */
function projectTickets(events: readonly SessionEvent[], diffs: string[]): ReplayTicket[] {
  const table = new Map<string, { ticketId: string; callId: string; name: string; status: string; events: number[]; reason?: string }>()
  const transitions: Readonly<Record<string, string>> = {
    'ticket/issued': 'issued',
    'ticket/approved': 'approved',
    'ticket/redeemed': 'redeemed',
    'ticket/consumed': 'consumed',
    'ticket/blocked': 'blocked',
  }
  for (const event of events) {
    if (!event.type.startsWith('ticket/')) continue
    const data = event.data as {
      ticketId?: unknown
      callId?: unknown
      name?: unknown
      reason?: unknown
    }
    if (typeof data.ticketId !== 'string') continue
    const ticketId = data.ticketId
    const entry =
      table.get(ticketId) ?? {
        ticketId,
        callId: typeof data.callId === 'string' ? data.callId : '',
        name: typeof data.name === 'string' ? data.name : '',
        status: 'issued',
        events: [],
      }
    entry.events.push(event.seq)
    const next = transitions[event.type]
    if (next === undefined) {
      // lease-renewed 等不改变状态；未知键不是错误（领域事件表可扩展）
    } else {
      if (event.type !== 'ticket/issued' && entry.status === 'issued' && next !== 'approved' && next !== 'blocked') {
        diffs.push(`ticket-transition:${ticketId}:${entry.status}->${next}`)
      }
      entry.status = next
      if (next === 'blocked' && typeof data.reason === 'string') entry.reason = data.reason
    }
    table.set(ticketId, entry)
  }
  return [...table.values()]
}
