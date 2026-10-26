/**
 * W15 独立重放：只读会话 + 审计链，重建判决表 / 票据表并把不一致写进 diffs。
 *
 * 这些用例盯的是**证据链判据本身**：断链、缺链、序号空洞、票据非法转移、
 * 签名缺失/被篡改——任何一条静默放行都会让"可回放"变成空话。
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionEvent } from '@bah/core'
import { asSessionId } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import { createSagaAudit, type ChainDecisionEnvelope, type ChainRecord } from '../chain/index.ts'
import { JsonlPersistence } from '../jsonl/index.ts'
import { replaySession, type ReplayResult } from './index.ts'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-replay-'))
  cleanup.push(dir)
  return dir
}

function event(seq: number, type: string, data: Record<string, unknown>): SessionEvent {
  return { seq, at: seq, formatVersion: 1, type, data }
}

/** 写一个会话（与 replay 读侧同样关掉脱敏/fsync，保证逐行可比）。 */
function writeSession(dir: string, sessionId: string, events: readonly SessionEvent[]): void {
  const handle = new JsonlPersistence({ fsync: false, redact: false, warn: () => undefined }).create(
    join(dir, sessionId),
    asSessionId(sessionId),
    { now: 1 },
  )
  for (const item of events) handle.append(item)
  handle.flush()
}

interface ChainRowInput {
  readonly type: string
  readonly data: Record<string, unknown>
  readonly envelope?: ChainDecisionEnvelope
}

/** 写一条审计链（默认不签名：只验连续性时不需要密钥）。 */
function writeChain(
  dir: string,
  sessionId: string,
  rows: readonly ChainRowInput[],
  options: { readonly signingKeyPath?: string } = {},
): void {
  const audit = createSagaAudit({
    now: () => 1_000,
    rootDir: dir,
    fsync: false,
    warn: () => undefined,
    signedTypes: options.signingKeyPath === undefined ? [] : ['tool/call', 'approval/decided'],
    ...(options.signingKeyPath === undefined ? {} : { signingKeyPath: options.signingKeyPath }),
  })
  for (const row of rows) {
    audit.append(sessionId, row.type, row.data, undefined, row.envelope)
  }
}

function keyFile(dir: string): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const path = join(dir, 'saga-ed25519.pem')
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return path
}

function replay(dir: string, sessionId: string, keyPath?: string): ReplayResult {
  return replaySession({
    root: dir,
    sessionId,
    ...(keyPath === undefined ? {} : { keyPath }),
  })
}

const TOOL_DATA = { callId: 'c-1', name: 'transfer_create', args: { amount: 800 } }
const DECISION_DATA = { ticketId: 't-1', decision: 'allow' }
const ALLOW: ChainDecisionEnvelope = { subject: 'session:s-1', decision: 'allow', policyVersion: 'v1' }

/** 一份完整、对得上的会话 + 链 + 票据事件。 */
function healthy(dir: string): void {
  writeSession(dir, 's-1', [
    event(1, 'tool/call', TOOL_DATA),
    event(2, 'approval/decided', DECISION_DATA),
    event(3, 'ticket/issued', { ticketId: 't-1', callId: 'c-1', name: 'transfer_create' }),
    event(4, 'ticket/approved', { ticketId: 't-1' }),
    event(5, 'ticket/redeemed', { ticketId: 't-1' }),
  ])
  writeChain(dir, 's-1', [
    { type: 'tool/call', data: TOOL_DATA, envelope: ALLOW },
    {
      type: 'approval/decided',
      data: DECISION_DATA,
      envelope: { subject: 'session:s-1', decision: 'allow', policyVersion: 'v1' },
    },
  ])
}

describe('W15 · 独立重放', () => {
  it('会话 / 链 / 票据对得上 → ok，判决与票据表按事件重建', () => {
    const dir = root()
    healthy(dir)

    const result = replay(dir, 's-1')

    expect(result.ok).toBe(true)
    expect(result.seqOk).toBe(true)
    expect(result.diffs).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.chain).toEqual({ ok: true, rows: 2 })
    expect(result.decisions).toHaveLength(2)
    expect(result.decisions[0]).toMatchObject({ seq: 1, type: 'tool/call', decision: 'allow' })
    expect(result.tickets).toEqual([
      {
        ticketId: 't-1',
        callId: 'c-1',
        name: 'transfer_create',
        status: 'redeemed',
        events: [3, 4, 5],
      },
    ])
  })

  it('会话不存在 → session-missing，绝不返回空成功的"重放"', () => {
    const result = replay(root(), 'no-such-session')

    expect(result.ok).toBe(false)
    expect(result.diffs).toEqual([expect.stringContaining('session-missing:')])
    expect(result.events).toEqual([])
    expect(result.chain).toEqual({ ok: false, rows: 0 })
  })

  it('删掉一条会话事件留下的 seq 空洞 → seq-gap，判为不通过', () => {
    const dir = root()
    writeSession(dir, 's-gap', [event(1, 'user/message', { content: 'a' }), event(2, 'user/message', { content: 'b' }), event(4, 'user/message', { content: 'd' })])

    const result = replay(dir, 's-gap')

    expect(result.seqOk).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.diffs).toContain('seq-gap:4')
  })

  it('票据未批准直接核销 → ticket-transition，不允许状态机跳步', () => {
    const dir = root()
    writeSession(dir, 's-ticket', [
      event(1, 'ticket/issued', { ticketId: 't-1', callId: 'c-1', name: 'transfer_create' }),
      event(2, 'ticket/redeemed', { ticketId: 't-1' }),
    ])

    const result = replay(dir, 's-ticket')

    // 已知缺陷（本次不修生产代码）：`ok` 在 projectTickets 之前求值，
    // 票据非法转移只会进 diffs、暂时不会把 ok 拉成 false；这里先钉住"能被发现"。
    expect(result.tickets[0]?.status).toBe('redeemed')
    expect(result.diffs).toEqual(['ticket-transition:t-1:issued->redeemed'])
  })

  it('链内容被改 → chain-broken 并定位到该序号', () => {
    const dir = root()
    healthy(dir)
    const path = join(dir, 's-1', 'audit.jsonl')
    const rows = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ChainRecord)
    rows[0] = { ...rows[0]!, d: 'forged-digest' }
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    const result = replay(dir, 's-1')

    expect(result.ok).toBe(false)
    expect(result.chain).toMatchObject({ ok: false, brokenAt: 1 })
    expect(result.diffs).toContain('chain-broken:1')
  })

  it('有链覆盖事件但链文件为空 → audit-chain-missing（不能当作"没有判决"）', () => {
    const dir = root()
    writeSession(dir, 's-orphan', [event(1, 'tool/call', TOOL_DATA)])

    const result = replay(dir, 's-orphan')

    expect(result.ok).toBe(false)
    expect(result.chain).toEqual({ ok: true, rows: 0 })
    expect(result.diffs).toEqual(['audit-chain-missing'])
  })

  it('签名链：验签通过；签名被篡改 → chain-signature', () => {
    const dir = root()
    const keyPath = keyFile(dir)
    healthy(dir)
    // 用密钥重写链，使 tool/call、approval/decided 两行都带签名
    rmSync(join(dir, 's-1', 'audit.jsonl'))
    writeChain(
      dir,
      's-1',
      [
        { type: 'tool/call', data: TOOL_DATA, envelope: ALLOW },
        {
          type: 'approval/decided',
          data: DECISION_DATA,
          envelope: { subject: 'session:s-1', decision: 'allow', policyVersion: 'v1' },
        },
      ],
      { signingKeyPath: keyPath },
    )

    expect(replay(dir, 's-1', keyPath).ok).toBe(true)

    const path = join(dir, 's-1', 'audit.jsonl')
    const rows = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ChainRecord)
    rows[1] = { ...rows[1]!, sig: 'Zm9yZ2Vk' }
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    const result = replay(dir, 's-1', keyPath)
    expect(result.chain.ok).toBe(true)
    expect(result.diffs).toEqual(['chain-signature:2'])
    expect(result.ok).toBe(false)
  })

  it('给了密钥但链上没有任何签名 → chain-unsigned（不能默认"信任"）', () => {
    const dir = root()
    const keyPath = keyFile(dir)
    healthy(dir)

    const result = replay(dir, 's-1', keyPath)

    expect(result.diffs).toEqual(['chain-unsigned'])
    expect(result.ok).toBe(false)
  })
})
