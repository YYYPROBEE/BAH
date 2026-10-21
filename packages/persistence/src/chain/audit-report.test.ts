import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildChainAudit, signatureCoverage } from './audit-report.ts'
import { ChainFile, createSagaAudit } from './index.ts'

import type { ChainRecord, SagaAuditHandle } from './index.ts'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-audit-report-'))
  cleanup.push(dir)
  return dir
}

function keyFile(dir: string): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const path = join(dir, 'saga-ed25519.pem')
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return path
}

function chainOf(dir: string): ChainFile {
  return new ChainFile({ rootDir: join(dir, 'audit'), fsync: false, warn: () => undefined })
}

function writeRows(dir: string, sagaId: string, rows: readonly ChainRecord[]): void {
  const sagaDir = join(dir, 'audit', sagaId)
  mkdirSync(sagaDir, { recursive: true })
  writeFileSync(join(sagaDir, 'audit.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8')
}

function row(overrides: Partial<ChainRecord> = {}): ChainRecord {
  return {
    s: 'signed',
    q: 1,
    t: 'saga/created',
    sub: 'signed',
    hb: [],
    d: 'd',
    keyVersion: 1,
    p: '',
    r: 'r',
    recordedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function fakeAudit(
  overrides: Partial<Pick<SagaAuditHandle, 'verifyContinuity' | 'verifySignatures'>> = {},
): SagaAuditHandle {
  return {
    append: () => ({ seqInSaga: 1, recordHash: 'r' }),
    verify: () => ({ ok: true }),
    verifyContinuity: () => ({ ok: true }),
    verifySignatures: () => ({ ok: true, checked: 1 }),
    anchor: async () => ({ merkleRoot: '', targets: [] }),
    ...overrides,
  }
}

function readerOf(dir: string, signingKeyPath?: string): SagaAuditHandle {
  return createSagaAudit({
    now: () => 1_700_000_000_000,
    rootDir: join(dir, 'audit'),
    fsync: false,
    warn: () => undefined,
    ...(signingKeyPath === undefined ? {} : { signingKeyPath }),
  })
}

/** 固定 golden 链：不经过当前写入器，改 `rowHash` 后必须变红（R169）。 */
const GOLDEN = [
  '{"s":"golden","q":1,"t":"saga/created","sub":"golden","hb":[],"d":"868ce2ea81c6702a6db74fb15c90213ddfc4e319e1b432a8529c02e3ed3d4565","keyVersion":1,"recordedAt":1700000000000,"p":"","r":"1db6d4c0703e0745c90009ae946608b86afbe418e7504d85679b2cf366eabf45"}',
  '{"s":"golden","q":2,"t":"saga/step-planned","sub":"s1","hb":[],"d":"ddc1c0285c289ec4c7f93a360035067b48d52e8417d85aa96535ce7fdd5fa61c","keyVersion":1,"recordedAt":1700000000000,"p":"1db6d4c0703e0745c90009ae946608b86afbe418e7504d85679b2cf366eabf45","r":"41768286865facfcb9a27056a651d1c37cdf11d1c55c4e879b51da0e4c318093"}',
].join('\n') + '\n'

function goldenDir(): string {
  const dir = root()
  mkdirSync(join(dir, 'audit', 'golden'), { recursive: true })
  writeFileSync(join(dir, 'audit', 'golden', 'audit.jsonl'), GOLDEN, 'utf8')
  return dir
}

describe('signatureCoverage', () => {
  it('只把“至少一条带签名”的类型计入应签；整类未签记为信息项', () => {
    const coverage = signatureCoverage([
      row({ t: 'saga/comp-issued', sig: undefined }),
      row({ t: 'saga/comp-issued', sig: 'c2ln' }),
      row({ t: 'saga/comp-result', sig: undefined }),
      row({ t: 'saga/created', sig: undefined }),
    ])
    expect(coverage).toEqual({
      signedExpected: 2,
      signedPresent: 1,
      unsignedTypes: ['saga/comp-result'],
    })
  })

  it('空链没有任何应签行', () => {
    expect(signatureCoverage([])).toEqual({ signedExpected: 0, signedPresent: 0, unsignedTypes: [] })
  })
})

describe('buildChainAudit', () => {
  it('golden 链连续性通过；--no-signature 时状态为 skipped-disabled', () => {
    const dir = goldenDir()
    const result = buildChainAudit(chainOf(dir), readerOf(dir), 'golden', { skipSignature: true })
    expect(result).toMatchObject({
      sagaId: 'golden',
      events: 2,
      chainOk: true,
      brokenAt: null,
      signedExpected: 0,
      signedPresent: 0,
      signatureState: 'skipped-disabled',
      signatureError: null,
    })
  })

  it('篡改 golden 链中间字段 → chainOk=false 且定位 brokenAt', () => {
    const dir = goldenDir()
    const path = join(dir, 'audit', 'golden', 'audit.jsonl')
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
    lines[1] = lines[1]!.replace('ddc1c028', '00000000')
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    const result = buildChainAudit(chainOf(dir), readerOf(dir), 'golden', { skipSignature: true })
    expect(result.chainOk).toBe(false)
    expect(result.brokenAt).toBe(2)
  })

  it('没有应签行时缺密钥不影响结论：verified', () => {
    const dir = goldenDir()
    const real = readerOf(dir)
    const result = buildChainAudit(
      chainOf(dir),
      fakeAudit({
        verifyContinuity: (sagaId) => real.verifyContinuity(sagaId),
        verifySignatures: () => {
          throw new Error('must not be called')
        },
      }),
      'golden',
      { skipSignature: false },
    )
    expect(result.signatureState).toBe('verified')
    expect(result.signatureError).toBeNull()
  })

  it('真实签名链 → verified，覆盖计数与链连续性同时成立', () => {
    const dir = root()
    const key = keyFile(dir)
    const writer = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: join(dir, 'audit'),
      signingKeyPath: key,
      fsync: false,
      warn: () => undefined,
    })
    writer.append('signed', 'saga/comp-issued', { sagaId: 'signed', compId: 'c1' })
    writer.append('signed', 'saga/comp-issued', { sagaId: 'signed', compId: 'c2' })

    const reader = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: join(dir, 'audit'),
      signingKeyPath: key,
      fsync: false,
      warn: () => undefined,
    })
    const result = buildChainAudit(chainOf(dir), reader, 'signed', { skipSignature: false })
    expect(result).toMatchObject({
      events: 2,
      chainOk: true,
      signedExpected: 2,
      signedPresent: 2,
      signatureState: 'verified',
      signatureError: null,
    })
  })

  it('伪造签名 → invalid 且保留理由码', () => {
    const dir = root()
    const key = keyFile(dir)
    const writer = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: join(dir, 'audit'),
      signingKeyPath: key,
      fsync: false,
      warn: () => undefined,
    })
    writer.append('signed', 'saga/comp-issued', { sagaId: 'signed', compId: 'c1' })
    const path = join(dir, 'audit', 'signed', 'audit.jsonl')
    const line = JSON.parse(readFileSync(path, 'utf8').trim()) as ChainRecord
    writeFileSync(path, `${JSON.stringify({ ...line, sig: Buffer.from('forged').toString('base64') })}\n`, 'utf8')

    const reader = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: join(dir, 'audit'),
      signingKeyPath: key,
      fsync: false,
      warn: () => undefined,
    })
    const result = buildChainAudit(chainOf(dir), reader, 'signed', { skipSignature: false })
    expect(result.signatureState).toBe('invalid')
    expect(result.signatureError).toBe('signature-invalid')
  })

  it('缺密钥 → skipped-no-key，且与 invalid 区分', () => {
    const dir = root()
    const key = keyFile(dir)
    const writer = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: join(dir, 'audit'),
      signingKeyPath: key,
      fsync: false,
      warn: () => undefined,
    })
    writer.append('signed', 'saga/comp-issued', { sagaId: 'signed', compId: 'c1' })

    const reader = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: join(dir, 'audit'),
      signingKeyPath: join(dir, 'missing.pem'),
      fsync: false,
      warn: () => undefined,
    })
    const result = buildChainAudit(chainOf(dir), reader, 'signed', { skipSignature: false })
    expect(result.signatureState).toBe('skipped-no-key')
    expect(result.signatureError).toBe('signing-key-missing')
  })

  it('非签名异常统一归一为 signature-verify-failed', () => {
    const dir = root()
    writeRows(dir, 'signed', [row({ t: 'saga/comp-issued', sig: 'c2ln' })])
    const result = buildChainAudit(
      chainOf(dir),
      fakeAudit({
        verifySignatures: () => {
          throw new Error('boom')
        },
      }),
      'signed',
      { skipSignature: false },
    )
    expect(result.signatureState).toBe('invalid')
    expect(result.signatureError).toBe('signature-verify-failed')
  })
})
