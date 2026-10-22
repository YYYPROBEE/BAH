/**
 * `bah audit` 子命令（施工单 16）。
 *
 * 只读：不建库、不迁移、不修链。链连续性/签名来自 `@bah/persistence` 的只读报告，
 * 投影与锚定由本层装配（见 `audit-projection.ts` / `audit-anchors.ts`）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { reasonOf } from '@bah/util'
import { ChainFile, buildChainAudit, createSagaAudit } from '@bah/persistence'

import { buildAnchorsAudit, type AnchorEntry } from './audit-anchors.ts'
import {
  projectionDiffFor,
  projectionFor,
  type ProjectionAudit,
  type ProjectionState,
} from './audit-projection.ts'
import type { CliIo, CliOptions } from './run.ts'
import type { ChainAudit, ChainRecord } from '@bah/persistence'

export const AUDIT_USAGE = '用法：bah audit --dir <path> [--saga <id>] [选项]（-h 看完整帮助）'

export const AUDIT_HELP = [
  'bah audit —— 对落盘目录做一次只读证据链核验（施工单 16）',
  '',
  AUDIT_USAGE,
  '',
  '选项：',
  '  --dir <path>        待审计目录（缺省 sessions/）',
  '  --saga <id>         只审一条链（缺省全部）',
  '  --db <path>         saga 库（缺省 <dir>/saga.sqlite）',
  '  --no-projection     跳过投影重算',
  '  --key <path>        验签私钥（缺省 keys/saga-ed25519.pem）',
  '  --format <fmt>      text | json（缺省 text）',
  '  --no-signature      跳过验签（只验链连续性）',
  '  -h, --help          显示本帮助',
].join('\n')

/** 解析后的参数。 */
export interface AuditArgs {
  readonly dir: string
  readonly saga?: string
  readonly db: string
  readonly noProjection: boolean
  readonly key: string
  readonly format: 'text' | 'json'
  readonly noSignature: boolean
  readonly help: boolean
}

/** 参数解析结果（与主命令同构：失败带一行理由，退出码 2）。 */
export type AuditParseResult =
  | { readonly ok: true; readonly args: AuditArgs }
  | { readonly ok: false; readonly error: string }

/** 单链的最终报告。 */
export interface ChainReport extends ChainAudit {
  readonly projectionState: ProjectionState
  readonly projectionDiff: number | null
}

/** 目录级报告（JSON 字段即契约）。 */
export interface AuditReport {
  readonly dir: string
  readonly db: string
  readonly chains: readonly ChainReport[]
  readonly anchors: readonly AnchorEntry[]
  readonly reverseGaps: readonly string[]
  readonly errors: readonly string[]
  readonly dbState: ProjectionAudit['dbState']
  readonly ok: boolean
  readonly exitCode: number
}

/** `--dir` / `--saga` 的路径安全校验（与 `ChainFile` 同口径）。 */
const SAGA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** 解析 `bah audit` 自己的 flag。 */
export function parseAuditArgs(argv: readonly string[]): AuditParseResult {
  let dir: string | undefined
  let saga: string | undefined
  let db: string | undefined
  let noProjection = false
  let key: string | undefined
  let format: 'text' | 'json' = 'text'
  let noSignature = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] as string
    const separator = raw.indexOf('=')
    const flag = separator > 0 ? raw.slice(0, separator) : raw
    const inline = separator > 0 ? raw.slice(separator + 1) : undefined

    const value = (): string | undefined => {
      const candidate = inline ?? argv[index + 1]
      if (candidate === undefined || candidate.length === 0) return undefined
      if (inline === undefined) index += 1
      return candidate
    }

    switch (flag) {
      case '--dir': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        dir = read
        break
      }
      case '--saga': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        saga = read
        break
      }
      case '--db': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        db = read
        break
      }
      case '--key': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        key = read
        break
      }
      case '--format': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        if (read !== 'text' && read !== 'json') return failure(`${flag} 只接受 text | json`)
        format = read
        break
      }
      case '--no-projection':
        if (inline !== undefined) return failure(`${flag} 不接受值（写成 ${flag}）`)
        noProjection = true
        break
      case '--no-signature':
        if (inline !== undefined) return failure(`${flag} 不接受值（写成 ${flag}）`)
        noSignature = true
        break
      case '-h':
      case '--help':
        if (inline !== undefined) return failure(`${flag} 不接受值（写成 ${flag}）`)
        help = true
        break
      default:
        return failure(`未知参数 ${raw}`)
    }
  }

  const resolvedDir = dir ?? 'sessions'
  return {
    ok: true,
    args: {
      dir: resolvedDir,
      db: db ?? join(resolvedDir, 'saga.sqlite'),
      key: key ?? 'keys/saga-ed25519.pem',
      format,
      noProjection,
      noSignature,
      help,
      ...(saga === undefined ? {} : { saga }),
    },
  }
}

/** 执行一次审计；返回进程退出码。 */
export async function runAudit(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const parsed = parseAuditArgs(argv)
  if (!parsed.ok) {
    io.err(`bah audit: ${parsed.error}`)
    io.err(AUDIT_USAGE)
    return 2
  }
  if (parsed.args.help) {
    io.out(AUDIT_HELP)
    return 0
  }

  const cwd = options.root ?? process.cwd()
  const dir = resolve(cwd, parsed.args.dir)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    io.err(`bah audit: 目录不存在或不是目录：${dir}`)
    return 2
  }
  const dbPath = resolve(cwd, parsed.args.db)
  const keyPath = resolve(cwd, parsed.args.key)

  const sagaIds = discover(dir, parsed.args.saga)
  if (sagaIds.length === 0) {
    io.err(
      parsed.args.saga === undefined
        ? 'bah audit: 未找到可审计的链'
        : `bah audit: 未找到链 ${parsed.args.saga}`,
    )
    return 2
  }

  const chain = new ChainFile({ rootDir: dir, fsync: false, warn: (message) => io.err(message) })
  const audit = createSagaAudit({
    now: options.now ?? Date.now,
    rootDir: dir,
    signingKeyPath: keyPath,
    fsync: false,
    warn: (message) => io.err(message),
  })

  const results: ChainAudit[] = []
  const rows: ChainRecord[] = []
  const errors: string[] = []
  for (const sagaId of sagaIds) {
    try {
      const chainRows = chain.read(sagaId)
      results.push(buildChainAudit(chain, audit, sagaId, { skipSignature: parsed.args.noSignature }))
      rows.push(...chainRows)
    } catch (error) {
      errors.push(`${sagaId}: ${reasonOf(error)}`)
    }
  }

  const projection = projectionFor(
    chain,
    results.map((result) => ({
      sagaId: result.sagaId,
      hasEvents: result.events > 0,
      chainOk: result.chainOk,
    })),
    dbPath,
    { noProjection: parsed.args.noProjection, diff: projectionDiffFor },
  )

  // 锚定是目录级全局量：--saga 只收窄报告，不改变叶子集（R167）。
  let anchorRows = rows
  if (parsed.args.saga !== undefined) {
    anchorRows = []
    for (const sagaId of discover(dir, undefined)) {
      try {
        anchorRows.push(...chain.read(sagaId))
      } catch (error) {
        const message = `${sagaId}: ${reasonOf(error)}`
        if (!errors.includes(message)) errors.push(message)
      }
    }
  }
  const anchors = buildAnchorsAudit(anchorRows, dir)
  const report = makeReport(dir, dbPath, results, projection, anchors, errors)

  if (parsed.args.format === 'json') {
    io.out(JSON.stringify(report, null, 2))
  } else {
    io.out(renderText(report))
  }
  return report.exitCode
}

/** 目录下含 `audit.jsonl` 的 saga 目录；`--saga` 时只取该条。 */
function discover(dir: string, only: string | undefined): string[] {
  if (only !== undefined) {
    if (!SAGA_ID.test(only)) return []
    return existsSync(join(dir, only, 'audit.jsonl')) ? [only] : []
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'audit.jsonl')))
    .map((entry) => entry.name)
    .sort()
}

function makeReport(
  dir: string,
  dbPath: string,
  results: readonly ChainAudit[],
  projection: ProjectionAudit,
  anchors: ReturnType<typeof buildAnchorsAudit>,
  errors: readonly string[],
): AuditReport {
  const chains: ChainReport[] = results.map((result) => {
    const entry = projection.bySaga.get(result.sagaId) ?? { state: 'runtime-missing', diff: null }
    return { ...result, projectionState: entry.state, projectionDiff: entry.diff }
  })
  const exitCode = exitCodeOf(chains, projection, anchors, errors)
  return {
    dir,
    db: dbPath,
    chains,
    anchors: anchors.entries,
    reverseGaps: projection.reverseGaps,
    errors,
    dbState: projection.dbState,
    ok: exitCode === 0,
    exitCode,
  }
}

function exitCodeOf(
  chains: readonly ChainReport[],
  projection: ProjectionAudit,
  anchors: ReturnType<typeof buildAnchorsAudit>,
  errors: readonly string[],
): number {
  if (errors.length > 0) return 1
  if (
    chains.some(
      (chain) =>
        !chain.chainOk ||
        chain.signatureState === 'invalid' ||
        (chain.signatureState === 'verified' && chain.signedPresent < chain.signedExpected),
    )
  ) {
    return 1
  }
  if (
    chains.some(
      (chain) => chain.projectionState === 'diff-nonzero' || chain.projectionState === 'diff-error',
    )
  ) {
    return 1
  }
  if (projection.reverseGaps.length > 0) return 1
  if (
    anchors.entries.some(
      (entry) =>
        entry.state === 'mismatch' ||
        entry.state === 'ledger-invalid' ||
        entry.state === 'orphan-ledger',
    )
  ) {
    return 1
  }
  // `unsigned`（零应签行）与 `skipped-no-key` 同级：什么都没验过，不能说"通过"。
  // 退出码 2 = 审计未完成，比假绿安全。
  if (
    chains.some(
      (chain) => chain.signatureState === 'skipped-no-key' || chain.signatureState === 'unsigned',
    )
  ) {
    return 2
  }
  if (projection.dbState === 'invalid') return 2
  return 0
}

/** 人读输出。 */
export function renderText(report: AuditReport): string {
  const lines = [
    `bah audit · 目录 ${report.dir} · 链 ${report.chains.length} 条 · 库 ${report.dbState}`,
  ]
  for (const chain of report.chains) {
    const continuity = chain.chainOk ? '链连续' : `链断于 ${String(chain.brokenAt)}`
    const projection =
      chain.projectionDiff === null
        ? chain.projectionState
        : `${chain.projectionState} diff=${String(chain.projectionDiff)}`
    lines.push(
      `${chain.chainOk ? '✔' : '✘'} ${chain.sagaId}  ${String(chain.events)} 事件  ${continuity}  签名 ${String(chain.signedPresent)}/${String(chain.signedExpected)} ${chain.signatureState}  投影 ${projection}`,
    )
  }
  for (const anchor of report.anchors) {
    lines.push(`锚定 ${anchor.period} ${anchor.state}`)
  }
  if (report.reverseGaps.length > 0) {
    lines.push(`反向缺口：${report.reverseGaps.join(', ')}`)
  }
  for (const error of report.errors) {
    lines.push(`错误：${error}`)
  }
  lines.push(`结论：${report.ok ? '通过' : report.exitCode === 1 ? '发现异常' : '审计未完成'}`)
  return lines.join('\n')
}

/** 造一个用法失败结果。 */
function failure(error: string): AuditParseResult {
  return { ok: false, error }
}
