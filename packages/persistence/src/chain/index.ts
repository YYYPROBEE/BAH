/**
 * 审计证据链（SA-07 §3.3 / SA-11 §3.1–3.6）。
 *
 * - `recordHash = sha256(prevHash | canonicalJson(unsigned))`；
 *   unsigned = `{ s, q, t, sub, hb, d, keyVersion, recordedAt }`（v2 另加四个信封字段，
 *   租户化后新行另加 `tenant`），`p`/`r`/`v`/`sig` 不入哈希。
 * - `seqInSaga` 由 saga 内计数器生成；跨 saga 只用 `happensBefore` 显式边。
 * - Ed25519 签名白名单见 `SIGNED_TYPES`；`signedTypes` 只能取子集。
 * - 链记录写 `<root>/<sagaId>/audit.jsonl`（`ChainFile`），append 后 fsync。
 * - `beginDeferred()` 供协调器的单提交段使用：业务事务内只缓冲，
 *   在 sqlite `COMMIT` **之前**统一 append+fsync；`fn` 抛错则整段丢弃。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { BahError, canonicalJson, sha256Hex } from '@bah/util'

import {
  ChainFile,
  type ChainDecisionEnvelope,
  type ChainRecord,
} from './chain-file.ts'
import { canonicalOf, isBrokenRow, rowHash } from './hash.ts'
import { loadSigningKeys, signRecord, verifyRecord, type SigningKeys } from './sign.ts'

import type { Context } from '@bah/core'

export { ChainFile } from './chain-file.ts'
export { canonicalOf } from './hash.ts'
export type {
  ChainDecision,
  ChainDecisionEnvelope,
  ChainEnvelopeVersion,
  ChainFileOptions,
  ChainRecord,
} from './chain-file.ts'
export * from './vault.ts'
// B4 摘要投影单列一个文件：replay 从它取符号，避免把 `vault.ts`（value import core）拉进重放闭包
export * from './tool-result-summary.ts'

/** 创世前序哈希（空串，等价于"无前驱"）。 */
export const GENESIS_HASH = ''

/**
 * 签名类型白名单（SA-07 §3.3；`signedTypes` 只能取其子集）。
 *
 * B4（2026-10-27）：`sentry/decision` 加入白名单——它与会话链上的 `approval/decided`
 * 同为治理判决，高风险程度一致；白名单只放行、不强制，宿主侧缺钥时仍可选空集。
 */
export const SIGNED_TYPES = [
  'tool/call',
  'tool/result',
  'sentry/decision',
  'policy/decision',
  'saga/comp-issued',
  'saga/comp-result',
  'saga/residual-recorded',
  'saga/manually-closed',
  'approval/decided',
] as const

/** `bank:saga-audit` 的配置（SA-00 §10 / SA-11 §2）。 */
export interface AuditSettings {
  readonly signingKeyPath: string
  readonly keyVersion: number
  readonly signedTypes: readonly string[]
  readonly anchorTargets: readonly string[]
  readonly anchorIntervalMs: number
}

/** 单提交段内的延迟写批次（由协调器 `commitSegment` 驱动）。 */
export interface DeferredAudit {
  /** 把缓冲行按序落盘并 fsync；在 sqlite COMMIT 之前调用。 */
  flush(): void
  /** fn 抛错时丢弃缓冲（不落任何行）。 */
  discard(): void
}

/** 审计链接缝（结构与 `@bah/saga` 的 `SagaAudit` 兼容）。 */
export interface SagaAuditHandle {
  append(
    sagaId: string,
    type: string,
    data: unknown,
    refs?: { happensBefore?: readonly number[]; vaultRef?: string },
    /** v2 判决信封（W08）；省略 = 写 v1 行，既有调用点不需要改。 */
    envelope?: ChainDecisionEnvelope,
  ): { seqInSaga: number; recordHash: string }
  verify(sagaId?: string): { ok: boolean; brokenAt?: number }
  /** 只验哈希连续性：不读密钥、不验签；缺密钥也能给出链断结论。 */
  verifyContinuity(sagaId?: string): { ok: boolean; brokenAt?: number }
  /** 只验签名：缺密钥抛 `signing-key-missing`，验签失败抛 `signature-invalid`。 */
  verifySignatures(sagaId?: string): { ok: boolean; checked: number }
  anchor(period: string): Promise<{ merkleRoot: string; targets: readonly string[] }>
  /** 内部接缝：协调器单提交段使用；不是跨包公开契约。 */
  beginDeferred?(): DeferredAudit
}

/** 建链的输入。 */
export interface SagaAuditOptions {
  /** 落账时刻（唯一时间来源）。 */
  readonly now: () => number
  /** 事件出口（`saga/vault-accessed` / `saga/anchor-published`）；缺省不派发。 */
  readonly ctx?: Context
  /** 密钥版本（入 unsigned 投影）。 */
  readonly keyVersion?: number
  /** 签名类型白名单（必须是 `SIGNED_TYPES` 子集）。 */
  readonly signedTypes?: readonly string[]
  /** Ed25519 私钥路径；缺省 `keys/saga-ed25519.pem`。 */
  readonly signingKeyPath?: string
  /** 链根目录；缺省 = 进程内内存链。 */
  readonly rootDir?: string
  /** 锚定发布目标（目录或 `.json` 文件路径）。 */
  readonly anchorTargets?: readonly string[]
  /** 每次 append 后是否 fsync（默认 true）。 */
  readonly fsync?: boolean
  /** 尾行截断告警出口。 */
  readonly warn?: (message: string) => void
  /**
   * 租户（01 TA-15）：写了就给**本链句柄写的每一行**带上 `tenant`。
   *
   * 放在**建链时**而不是每次 `append` 传，是为了"不可能漏传"：一个进程只服务一个租户，
   * 链句柄的生命周期内租户不会变。四类 append（tool/call、tool/result、
   * sentry/decision、approval/decided）因此天然都带租户——若做成逐次传参，
   * 忘一处就是一条无主的证据行，而它审计时看起来完全正常。
   */
  readonly tenant?: string
}

/** 校验并补齐 `bank:saga-audit` 配置。 */
export function parseAuditSettings(config: Readonly<Record<string, unknown>>): AuditSettings {
  const allowed = ['signingKeyPath', 'keyVersion', 'signedTypes', 'anchorTargets', 'anchorIntervalMs']
  const unknown = Object.keys(config).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    fail(`bank:saga-audit 出现未知配置键：${unknown.join(', ')}（可写：${allowed.join(' / ')}）`)
  }

  const signingKeyPath = config['signingKeyPath'] ?? 'keys/saga-ed25519.pem'
  if (typeof signingKeyPath !== 'string' || signingKeyPath.length === 0) {
    fail('signingKeyPath 必须是非空字符串')
  }

  const keyVersion = config['keyVersion'] ?? 1
  if (typeof keyVersion !== 'number' || !Number.isInteger(keyVersion) || keyVersion < 1) {
    fail('keyVersion 必须是 ≥ 1 的整数')
  }

  const signedTypes = readStringArray(config['signedTypes'], [...SIGNED_TYPES], 'signedTypes')
  const illegal = signedTypes.filter((type) => !(SIGNED_TYPES as readonly string[]).includes(type))
  if (illegal.length > 0) {
    fail(`signedTypes 只能是 SA-07 §3.3 白名单的子集；越界：${illegal.join(', ')}`)
  }

  const anchorTargets = readStringArray(config['anchorTargets'], [], 'anchorTargets')

  const anchorIntervalMs = config['anchorIntervalMs'] ?? 86_400_000
  if (typeof anchorIntervalMs !== 'number' || !Number.isInteger(anchorIntervalMs) || anchorIntervalMs < 1) {
    fail('anchorIntervalMs 必须是 ≥ 1 的整数')
  }

  return { signingKeyPath, keyVersion, signedTypes, anchorTargets, anchorIntervalMs }
}

/** 建一个链句柄（内存或 JSONL）。 */
export function createSagaAudit(options: SagaAuditOptions): SagaAuditHandle {
  const now = options.now
  const ctx = options.ctx
  const keyVersion = options.keyVersion ?? 1
  const signedTypes = options.signedTypes ?? [...SIGNED_TYPES]
  const signingKeyPath = options.signingKeyPath ?? 'keys/saga-ed25519.pem'
  const anchorTargets = options.anchorTargets ?? []
  const tenant = options.tenant
  const file = new ChainFile({
    ...(options.rootDir === undefined ? {} : { rootDir: resolve(options.rootDir) }),
    ...(options.fsync === undefined ? {} : { fsync: options.fsync }),
    ...(options.warn === undefined ? {} : { warn: options.warn }),
  })

  const anchors = loadAnchors(options.rootDir)
  let deferredRows: ChainRecord[] | undefined
  let keysCache: { readonly path: string; readonly keys: SigningKeys } | undefined

  function append(
    sagaId: string,
    type: string,
    data: unknown,
    refs?: { happensBefore?: readonly number[]; vaultRef?: string },
    envelope?: ChainDecisionEnvelope,
  ): { seqInSaga: number; recordHash: string } {
    const { seq, prevHash } = tailOf(file, sagaId, deferredRows)
    if (envelope !== undefined) assertDecisionEnvelope(envelope)
    const unsigned = {
      s: sagaId,
      q: seq + 1,
      t: type,
      sub: subjectRefOf(type, data),
      hb: refs?.happensBefore ?? [],
      d: sha256Hex(canonicalJson(data)),
      keyVersion,
      recordedAt: now(),
      // 只有建链时给了租户才写这个键：历史链没有它，读取端按"有则入哈希"兼容
      ...(tenant === undefined ? {} : { tenant }),
      ...(envelope === undefined
        ? {}
        : {
            version: 2 as const,
            subject: envelope.subject,
            decision: envelope.decision,
            policyVersion: envelope.policyVersion,
            // v2 显式化前驱；与短键 `p` 同值（见 `ChainDecisionEnvelope` 注释）
            prevHash,
          }),
    }
    const recordHash = sha256Hex(`${prevHash}|${canonicalJson(unsigned)}`)
    const record: ChainRecord = {
      ...unsigned,
      ...(refs?.vaultRef === undefined ? {} : { v: refs.vaultRef }),
      p: prevHash,
      r: recordHash,
      ...(signedTypes.includes(type)
        ? { sig: signRecord(signingKeys('signing-key-read', 1), recordHash) }
        : {}),
    }

    if (deferredRows !== undefined) deferredRows.push(record)
    else file.append(sagaId, record)

    return { seqInSaga: unsigned.q, recordHash }
  }

  function verifyContinuity(sagaId?: string): { ok: boolean; brokenAt?: number } {
    const rows = sagaId === undefined ? file.readAll() : file.read(sagaId)
    for (const [, chain] of groupBySaga(rows)) {
      let prev = GENESIS_HASH
      for (const row of chain) {
        if (isBrokenRow(prev, row)) {
          return { ok: false, brokenAt: row.q }
        }
        prev = row.r
      }
    }
    return { ok: true }
  }

  function verifySignatures(sagaId?: string): { ok: boolean; checked: number } {
    const rows = sagaId === undefined ? file.readAll() : file.read(sagaId)
    const signedCount = rows.filter((row) => row.sig !== undefined).length
    if (signedCount === 0) return { ok: true, checked: 0 }
    const keys = signingKeys('verify-key-read', signedCount)
    let checked = 0
    for (const row of rows) {
      if (row.sig === undefined) continue
      if (!verifyRecord(keys, row.r, row.sig)) {
        throw new BahError(
          'signature-invalid',
          `bah-saga: signature-invalid: 第 ${row.q} 条验签失败（${row.s}）`,
          { sagaId: row.s, seqInSaga: row.q },
        )
      }
      checked += 1
    }
    return { ok: true, checked }
  }

  function verify(sagaId?: string): { ok: boolean; brokenAt?: number } {
    const rows = sagaId === undefined ? file.readAll() : file.read(sagaId)
    const signedCount = rows.filter((row) => row.sig !== undefined).length
    const keys = signedCount > 0 ? signingKeys('verify-key-read', signedCount) : undefined

    for (const [chainSaga, chain] of groupBySaga(rows)) {
      let prev = GENESIS_HASH
      for (const row of chain) {
        if (isBrokenRow(prev, row)) {
          return { ok: false, brokenAt: row.q }
        }
        if (row.sig !== undefined) {
          if (keys === undefined || !verifyRecord(keys, row.r, row.sig)) {
            throw new BahError(
              'signature-invalid',
              `bah-saga: signature-invalid: 第 ${row.q} 条验签失败（${chainSaga}）`,
              { sagaId: chainSaga, seqInSaga: row.q },
            )
          }
        }
        prev = row.r
      }
    }
    return { ok: true }
  }

  async function anchor(period: string): Promise<{ merkleRoot: string; targets: readonly string[] }> {
    const leaves = file
      .readAll()
      .filter((row) => periodOf(row.recordedAt) === period)
      .map((row) => row.r)
    const merkleRoot = merkleRootOf(leaves)
    if (anchors.get(period) === merkleRoot) {
      return { merkleRoot, targets: anchorTargets }
    }
    publish(period, merkleRoot, anchorTargets)
    anchors.set(period, merkleRoot)
    saveAnchors(options.rootDir, anchors)
    ctx?.events.emit('saga/anchor-published', { period, merkleRoot, targets: anchorTargets })
    return { merkleRoot, targets: anchorTargets }
  }

  function signingKeys(purpose: string, count: number): SigningKeys {
    let keys = keysCache?.path === signingKeyPath ? keysCache.keys : undefined
    if (keys === undefined) {
      keys = loadSigningKeys(signingKeyPath, purpose, 0)
      keysCache = { path: signingKeyPath, keys }
    }
    // 访问审计按「本次操作」聚合：缓存只省磁盘读，不省审计事件。
    if (count > 0) emitKeyAccess(ctx, signingKeyPath, keyVersion, purpose, count)
    return keys
  }

  return {
    append,
    verify,
    verifyContinuity,
    verifySignatures,
    anchor,
    beginDeferred() {
      if (deferredRows !== undefined) {
        throw new BahError('audit-deferred-nested', 'bah-saga: audit-deferred-nested: 同一链已有未结束的延迟写批次')
      }
      deferredRows = []
      return {
        flush() {
          const rows = deferredRows
          if (rows === undefined) return
          deferredRows = undefined
          for (const row of rows) file.append(row.s, row)
        },
        discard() {
          deferredRows = undefined
        },
      }
    },
  }
}

/** 一条链记录的期望 recordHash：写入与所有校验路径的唯一算法入口。 */
/** 确定性 Merkle 根：叶子两两 `sha256(left + right)`，奇数层末叶轮空晋级。 */
export function merkleRootOf(leaves: readonly string[]): string {
  if (leaves.length === 0) return sha256Hex('')
  let level = [...leaves]
  while (level.length > 1) {
    const next: string[] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index] as string
      const right = level[index + 1]
      next.push(right === undefined ? left : sha256Hex(`${left}${right}`))
    }
    level = next
  }
  const root = level[0]
  if (root === undefined) throw new BahError('chain-empty', 'bah-saga: chain-empty: Merkle 叶集为空')
  return root
}

/** epoch ms → 锚定分组 `YYYY-MM`（UTC；只用于分组，不参与因果判定）。 */
export function periodOf(recordedAt: number): string {
  return new Date(recordedAt).toISOString().slice(0, 7)
}

/** 尾部（持久化 + 延迟缓冲）的 seq 与 hash。 */
function tailOf(
  file: ChainFile,
  sagaId: string,
  pending: readonly ChainRecord[] | undefined,
): { seq: number; prevHash: string } {
  const persisted = file.read(sagaId)
  const lastPersisted = persisted[persisted.length - 1]
  let seq = lastPersisted?.q ?? 0
  let prevHash = lastPersisted?.r ?? GENESIS_HASH
  for (const row of pending ?? []) {
    if (row.s !== sagaId) continue
    seq = row.q
    prevHash = row.r
  }
  return { seq, prevHash }
}

function groupBySaga(rows: readonly ChainRecord[]): Map<string, ChainRecord[]> {
  const groups = new Map<string, ChainRecord[]>()
  for (const row of rows) {
    const bucket = groups.get(row.s)
    if (bucket === undefined) groups.set(row.s, [row])
    else bucket.push(row)
  }
  return groups
}

/** 主体引用：优先 stepId / compId / ticketId；恢复事件额外带上 action 供回放还原步骤态。 */
function subjectRefOf(type: string, data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const record = data as Record<string, unknown>
  if (type === 'saga/recovered') {
    const stepId = record['stepId']
    const action = record['action']
    if (typeof stepId === 'string' && typeof action === 'string') return `${stepId}#${action}`
  }
  // W08：`tool/call` / `sentry/decision` 的对象引用是 callId；放在 step/comp 之后，
  // 确保既有 `saga/*` 行的 sub 取值不被改变。
  for (const key of ['stepId', 'compId', 'ticketId', 'sagaId', 'callId', 'dlqId']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * v2 信封的运行期校验（类型不负责安全：宿主可能从配置/端口拿到任意字符串）。
 *
 * 只校验"能进哈希"的最小形状；**不**校验 decision 的枚举值——枚举值被改成
 * 任意字符串时，`verifyContinuity` 会用 recordHash 定位到具体条目，而不是解析期丢证据。
 */
function assertDecisionEnvelope(envelope: ChainDecisionEnvelope): void {
  if (typeof envelope.subject !== 'string' || envelope.subject.length === 0) {
    throw new BahError('chain-envelope-invalid', 'bah-saga: chain-envelope-invalid: subject 必须是非空字符串')
  }
  if (typeof envelope.decision !== 'string') {
    throw new BahError('chain-envelope-invalid', 'bah-saga: chain-envelope-invalid: decision 必须是字符串')
  }
  if (typeof envelope.policyVersion !== 'string' || envelope.policyVersion.length === 0) {
    throw new BahError(
      'chain-envelope-invalid',
      'bah-saga: chain-envelope-invalid: policyVersion 必须是非空字符串',
    )
  }
}

function emitKeyAccess(
  ctx: Context | undefined,
  signingKeyPath: string,
  keyVersion: number,
  purpose: string,
  count: number,
): void {
  ctx?.events.emit('saga/vault-accessed', {
    vaultId: signingKeyPath,
    keyVersion,
    purpose: `${purpose}(count=${count})`,
  })
}

/** 锚定台账（同 period 同 root 幂等）。 */
function anchorsPath(rootDir: string | undefined): string | undefined {
  return rootDir === undefined ? undefined : join(resolve(rootDir), 'anchors.json')
}

function loadAnchors(rootDir: string | undefined): Map<string, string> {
  const path = anchorsPath(rootDir)
  if (path === undefined) return new Map()
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map()
    return new Map(Object.entries(parsed as Record<string, string>))
  } catch {
    return new Map()
  }
}

function saveAnchors(rootDir: string | undefined, anchors: ReadonlyMap<string, string>): void {
  const path = anchorsPath(rootDir)
  if (path === undefined) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(Object.fromEntries(anchors))}\n`, 'utf8')
}

/** 三点发布：目标为目录则写 `anchor-<period>.json`，为 `.json` 则直接写该文件。 */
function publish(period: string, merkleRoot: string, targets: readonly string[]): void {
  const payload = `${JSON.stringify({ period, merkleRoot }, null, 2)}\n`
  for (const target of targets) {
    const resolved = resolve(target)
    if (resolved.toLowerCase().endsWith('.json')) {
      mkdirSync(dirname(resolved), { recursive: true })
      writeFileSync(resolved, payload, 'utf8')
    } else {
      mkdirSync(resolved, { recursive: true })
      writeFileSync(join(resolved, `anchor-${period}.json`), payload, 'utf8')
    }
  }
}

function readStringArray(value: unknown, fallback: readonly string[], key: string): readonly string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${key} 必须是字符串数组`)
  }
  return value as readonly string[]
}

function fail(message: string): never {
  throw new BahError('invalid-config', `bah-saga: invalid-config: ${message}`)
}
