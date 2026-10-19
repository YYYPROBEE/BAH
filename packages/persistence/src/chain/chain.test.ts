/**
 * SA-11 链 / 签名 / 金库 / 锚定用例（T-SA08-003/004 亦在此交叉覆盖）。
 */

import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import { canonicalJson, sha256Hex } from '@bah/util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ChainFile,
  GENESIS_HASH,
  SIGNED_TYPES,
  canonicalOf,
  createSagaAudit,
  merkleRootOf,
  parseAuditSettings,
  periodOf,
  revealSensitive,
  stashSensitive,
  VAULT_STORE,
} from './index.ts'
import { createSagaStore } from '../saga-store/index.ts'

import type { ChainRecord } from './index.ts'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-chain-'))
  cleanup.push(dir)
  return dir
}

function keyFile(dir: string): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const path = join(dir, 'saga-ed25519.pem')
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return path
}

function audit(dir: string, options: Partial<Parameters<typeof createSagaAudit>[0]> = {}): ReturnType<typeof createSagaAudit> {
  return createSagaAudit({
    now: () => 1_000,
    rootDir: join(dir, 'audit'),
    fsync: false,
    warn: () => undefined,
    ...options,
  })
}

describe('哈希链', () => {
  it('T-SA08-003 / T-SA11-001 / T-SA11-002：100 条链可验，篡改第 50 行定位 q=50', () => {
    const dir = root()
    const chain = audit(dir)
    for (let index = 1; index <= 100; index += 1) {
      chain.append('s1', 'saga/step-planned', { sagaId: 's1', stepId: `step-${index}` })
    }
    expect(chain.verify('s1')).toEqual({ ok: true })
    expect(chain.verify()).toEqual({ ok: true })

    const path = join(dir, 'audit', 's1', 'audit.jsonl')
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
    const row = JSON.parse(lines[49] as string) as ChainRecord
    const tampered = { ...row, d: sha256Hex('tampered') }
    lines[49] = JSON.stringify(tampered)
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')

    const reopened = audit(dir)
    expect(reopened.verify('s1')).toEqual({ ok: false, brokenAt: 50 })
  })

  it('T-SA08-004 / T-SA11-003 / T-SA11-004：白名单全签名；验签失败抛 signature-invalid', () => {
    const dir = root()
    const signingKeyPath = keyFile(dir)
    expect(() =>
      parseAuditSettings({ signedTypes: [...SIGNED_TYPES, 'saga/created'] }),
    ).toThrow(/signedTypes/)

    const chain = audit(dir, { signingKeyPath, signedTypes: [...SIGNED_TYPES] })
    for (const type of SIGNED_TYPES) {
      chain.append('s1', type, { sagaId: 's1', compId: `comp-${type}` })
    }
    chain.append('s1', 'saga/created', { sagaId: 's1' })
    expect(chain.verify('s1')).toEqual({ ok: true })

    const path = join(dir, 'audit', 's1', 'audit.jsonl')
    const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
    const row = JSON.parse(lines[0] as string) as ChainRecord
    expect(row.sig).toBeDefined()
    lines[0] = JSON.stringify({ ...row, sig: Buffer.from('forged').toString('base64') })
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')

    const reopened = audit(dir, { signingKeyPath, signedTypes: [...SIGNED_TYPES] })
    expect(() => reopened.verify('s1')).toThrow(/signature-invalid/)
  })

  it('T-SA11-006：键序不敏感（同 saga/同 q，两序 → 同 recordHash）', () => {
    const firstChain = audit(root())
    const secondChain = audit(root())
    const first = firstChain.append('s1', 'saga/created', { b: 2, a: 1 })
    const second = secondChain.append('s1', 'saga/created', { a: 1, b: 2 })
    expect(first.recordHash).toBe(second.recordHash)
  })

  it('T-SA11-007：seqInSaga 严格递增，时间戳不参与因果', () => {
    const dir = root()
    let now = 10_000
    const chain = createSagaAudit({
      now: () => (now -= 1_000),
      rootDir: join(dir, 'audit'),
      fsync: false,
    })
    const seqs = [1, 2, 3].map((index) => chain.append('s1', 'saga/step-planned', { stepId: `s${index}` }).seqInSaga)
    expect(seqs).toEqual([1, 2, 3])
    expect(chain.verify()).toEqual({ ok: true })
  })

  it('T-SA11-018：append 的 unsigned 与 canonicalOf 逐键同构，同一行 verify 必过', () => {
    const dir = root()
    const chain = audit(dir)
    const appended = chain.append('s1', 'saga/created', { sagaId: 's1' })
    const row = new ChainFile({ rootDir: join(dir, 'audit'), fsync: false }).read('s1')[0] as ChainRecord

    expect(Object.keys(canonicalOf(row)).sort()).toEqual(
      ['d', 'hb', 'keyVersion', 'q', 'recordedAt', 's', 'sub', 't'].sort(),
    )
    expect(row.r).toBe(sha256Hex(`${GENESIS_HASH}|${canonicalJson(canonicalOf(row))}`))
    expect(appended.recordHash).toBe(row.r)
  })

  it('T-SA11-010：密钥权限（POSIX 600；Windows 豁免）', () => {
    const dir = root()
    const signingKeyPath = keyFile(dir)
    if (process.platform !== 'win32') {
      chmodSync(signingKeyPath, 0o644)
      const chain = audit(dir, { signingKeyPath, signedTypes: ['tool/call'] })
      expect(() => chain.append('s1', 'tool/call', { sagaId: 's1' })).toThrow(/signing-key-permission/)
    } else {
      // Windows 无 POSIX 权限位：按 SA-11 §3.3 豁免，载入不应失败。
      const chain = audit(dir, { signingKeyPath, signedTypes: ['tool/call'] })
      expect(() => chain.append('s1', 'tool/call', { sagaId: 's1' })).not.toThrow()
    }
  })
})

describe('金库与访问审计', () => {
  it('T-SA11-008：事件流不含明文，明文只在 vault；授权读取可还原', () => {
    const dir = root()
    const signingKeyPath = keyFile(dir)
    const chain = audit(dir, { signingKeyPath })
    const plain = { amountCents: 123_456, payee: '张三', cardNo: '6222 0202 0000 1234' }

    const vaultId = (() => {
      const ctx = createContext()
      const store = createSagaStore({ dbPath: ':memory:' })
      ctx.provide(VAULT_STORE, store)
      return stashSensitive(ctx, { signingKeyPath, keyVersion: 1 }, 's1', plain)
    })()

    chain.append('s1', 'saga/created', plain, { vaultRef: vaultId })
    const text = readFileSync(join(dir, 'audit', 's1', 'audit.jsonl'), 'utf8')
    expect(text).not.toContain('6222')
    expect(text).not.toContain('张三')
    expect(text).toContain(sha256Hex(canonicalJson(plain)))

    const ctx = createContext()
    const store = createSagaStore({ dbPath: ':memory:' })
    ctx.provide(VAULT_STORE, store)
    const storedId = stashSensitive(ctx, { signingKeyPath, keyVersion: 1 }, 's1', plain)
    expect(storedId).toBe(vaultId)
    const stored = store.tx((tx) => tx.readVault(storedId))
    expect(stored?.keyVersion).toBe(1)
    expect(Buffer.from(stored?.cipherText ?? new Uint8Array()).toString('utf8')).not.toContain('6222')
    expect(revealSensitive(ctx, { signingKeyPath, keyVersion: 1 }, storedId)).toEqual(plain)
  })

  it('T-SA11-009：一次 verify 读多行只落一条聚合 vault-accessed', () => {
    const dir = root()
    const signingKeyPath = keyFile(dir)
    const ctx = createContext()
    const seen: Array<{ purpose: string; keyVersion: number; vaultId: string }> = []
    ctx.events.on('saga/vault-accessed', (payload: unknown) => {
      seen.push(payload as { purpose: string; keyVersion: number; vaultId: string })
    })
    const chain = audit(dir, { ctx, signingKeyPath, signedTypes: [...SIGNED_TYPES] })
    chain.append('s1', 'tool/call', { sagaId: 's1' })
    chain.append('s1', 'tool/result', { sagaId: 's1' })
    chain.append('s1', 'approval/decided', { sagaId: 's1' })
    seen.length = 0

    expect(chain.verify('s1')).toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ vaultId: signingKeyPath, keyVersion: 1 })
    expect(seen[0]?.purpose).toBe('verify-key-read(count=3)')
  })
})

describe('Merkle 锚定', () => {
  it('T-SA11-013/014/015：根与手工一致；同日重复幂等；三点发布', async () => {
    const dir = root()
    const at = Date.UTC(2026, 9, 18, 2, 0, 0)
    const chain = createSagaAudit({ now: () => at, rootDir: join(dir, 'audit'), fsync: false })
    chain.append('s1', 'saga/created', { sagaId: 's1' })
    chain.append('s2', 'saga/created', { sagaId: 's2' })
    chain.append('s3', 'saga/created', { sagaId: 's3' })

    const rows = new ChainFile({ rootDir: join(dir, 'audit'), fsync: false }).readAll()
    const expected = merkleRootOf(rows.map((row) => row.r))
    expect(periodOf(at)).toBe('2026-10')

    const dirA = join(dir, 'cold')
    const dirB = join(dir, 'offline')
    const fileC = join(dir, 'digest', 'anchor.json')
    const targeted = createSagaAudit({
      now: () => at,
      rootDir: join(dir, 'audit'),
      fsync: false,
      anchorTargets: [dirA, dirB, fileC],
    })
    const published: unknown[] = []
    const ctx = createContext()
    ctx.events.on('saga/anchor-published', (payload: unknown) => published.push(payload))
    // 重建句柄以挂事件出口（同一 root，读同一链）。
    const withCtx = createSagaAudit({
      now: () => at,
      rootDir: join(dir, 'audit'),
      fsync: false,
      anchorTargets: [dirA, dirB, fileC],
      ctx,
    })

    const first = await withCtx.anchor('2026-10')
    expect(first.merkleRoot).toBe(expected)
    expect(first.targets).toEqual([dirA, dirB, fileC])
    expect(existsSync(join(dirA, 'anchor-2026-10.json'))).toBe(true)
    expect(existsSync(join(dirB, 'anchor-2026-10.json'))).toBe(true)
    expect(JSON.parse(readFileSync(fileC, 'utf8'))).toEqual({ period: '2026-10', merkleRoot: expected })
    expect(published).toHaveLength(1)

    const second = await withCtx.anchor('2026-10')
    expect(second.merkleRoot).toBe(expected)
    expect(published).toHaveLength(1)

    // 未使用的句柄只用于类型闭环（避免 lint 噪声）。
    expect(targeted.verify()).toEqual({ ok: true })
  })
})

