/**
 * 只读审计报告。
 *
 * 判定逻辑留在 `@bah/persistence`：链连续性、签名覆盖、签名结论都不依赖 saga 语义。
 * 投影重算需要 `reduceSaga`，由 CLI 装配层另行注入。
 */

import { errorCodeOf } from '@bah/util'

import { SIGNED_TYPES } from './index.ts'

import type { ChainFile } from './chain-file.ts'
import type { ChainRecord, SagaAuditHandle } from './index.ts'

/**
 * 签名结论。
 *
 * `skipped-no-key` 与 `skipped-disabled` 必须分开（R160）；
 * `unsigned` 是第四种：**没有应签行**——此时"验过"是假话，只能是"没签过"。
 */
export type SignatureState =
  | 'verified'
  | 'invalid'
  | 'skipped-no-key'
  | 'skipped-disabled'
  | 'unsigned'

/** 一条链的审计结论。 */
export interface ChainAudit {
  readonly sagaId: string
  readonly events: number
  readonly chainOk: boolean
  readonly brokenAt: number | null
  /** 类型内应签的行数（见 `signatureCoverage`）。 */
  readonly signedExpected: number
  /** 类型内实际带签名的行数。 */
  readonly signedPresent: number
  /** 整类都没有签名的白名单类型：视为写入方 `signedTypes` 配置排除，仅作信息项。 */
  readonly unsignedTypes: readonly string[]
  readonly signatureState: SignatureState
  readonly signatureError: string | null
}

/** 构建输入的只读选项。 */
export interface ChainAuditOptions {
  readonly skipSignature: boolean
}

/** 签名覆盖统计：只在“该类型至少有一条签名”时把整类计入应签。 */
export interface SignatureCoverage {
  readonly signedExpected: number
  readonly signedPresent: number
  readonly unsignedTypes: readonly string[]
}

/** 白名单事件的实际签名覆盖（不按白名单全集断言，避免误报配置排除的类型）。 */
export function signatureCoverage(rows: readonly ChainRecord[]): SignatureCoverage {
  const byType = new Map<string, { total: number; signed: number }>()
  for (const row of rows) {
    if (!SIGNED_TYPES.some((type) => type === row.t)) continue
    const entry = byType.get(row.t) ?? { total: 0, signed: 0 }
    entry.total += 1
    if (row.sig !== undefined) entry.signed += 1
    byType.set(row.t, entry)
  }

  let signedExpected = 0
  let signedPresent = 0
  const unsignedTypes: string[] = []
  for (const [type, entry] of byType) {
    if (entry.signed === 0) {
      unsignedTypes.push(type)
      continue
    }
    signedExpected += entry.total
    signedPresent += entry.signed
  }
  return { signedExpected, signedPresent, unsignedTypes }
}

/**
 * 对单条链做一次只读审计。
 *
 * 端口注入：`chain` 只读链文件，`audit` 提供连续性/验签。函数本身不打开库、不写盘。
 */
export function buildChainAudit(
  chain: ChainFile,
  audit: SagaAuditHandle,
  sagaId: string,
  options: ChainAuditOptions,
): ChainAudit {
  const rows = chain.read(sagaId)
  const continuity = audit.verifyContinuity(sagaId)
  const coverage = signatureCoverage(rows)
  const base = {
    sagaId,
    events: rows.length,
    chainOk: continuity.ok,
    brokenAt: continuity.brokenAt ?? null,
    signedExpected: coverage.signedExpected,
    signedPresent: coverage.signedPresent,
    unsignedTypes: coverage.unsignedTypes,
  }

  if (options.skipSignature) {
    return { ...base, signatureState: 'skipped-disabled', signatureError: null }
  }

  // 没有"类型内应签"的行：**什么都没签**，不能说"验过"。
  // 以前这里返回 `verified`，于是空链/纯工具事件的链在报告里显示"签名通过"——
  // 一个恰好没有签名可验的链，被读成了"签名验证成功"。
  if (coverage.signedExpected === 0) {
    return { ...base, signatureState: 'unsigned', signatureError: null }
  }

  try {
    audit.verifySignatures(sagaId)
    return { ...base, signatureState: 'verified', signatureError: null }
  } catch (error) {
    const code = errorCodeOf(error, 'signature-verify-failed')
    return {
      ...base,
      signatureState: code === 'signing-key-missing' ? 'skipped-no-key' : 'invalid',
      signatureError: code,
    }
  }
}
