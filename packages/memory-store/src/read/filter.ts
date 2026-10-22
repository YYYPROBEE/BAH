/**
 * 过滤链（施工文档 §7.2）：**纯函数**，不碰数据库。
 *
 * 为什么不用一条 SQL 干完：`filteredOut` 要给出**逐条原因**（答辩时 D2 的对照证据就是
 * 它），而 SQL 只告诉你"没查到"，不告诉你"因为哪条被排掉"。把判决搬到内存里，代价是
 * 全量取行——单用户记忆条数有界（`listUnits` 上限 500），这个代价换来的可解释性值得。
 *
 * 原因码五类（文档 §7.2 写了四类，第五类 `scene` 是 D2「跨场景错配对比」要的）：
 * `scene` / `state` / `superseded` / `valid_to` / `sensitivity`。
 */

import { BASIS_BY_PREDICATE } from '../words.ts'

import type { MemoryStore, MemoryUnitRow } from '../store/index.ts'
import type { Scene } from '../types.ts'

export type FilterReason = 'scene' | 'state' | 'superseded' | 'valid_to' | 'retention' | 'sensitivity'

export interface FilterInput {
  readonly rows: readonly MemoryUnitRow[]
  /** 本次检索允许命中的场景（borrow 时含源域）。 */
  readonly domains: readonly Scene[]
  readonly nowIso: string
  /** 权限矩阵上限（fail-closed：默认 2）。 */
  readonly sensitivityCeiling: number
  readonly maxK: number
}

export interface FilterOutcome {
  /** 过滤前通过场景命中的 id（`AccessLogLine.retrieved`）。 */
  readonly retrieved: readonly string[]
  readonly filteredOut: readonly { readonly unitId: string; readonly reason: FilterReason }[]
  /** 最终入选的行（已排序、已截断）。 */
  readonly selected: readonly MemoryUnitRow[]
}

function judge(
  row: MemoryUnitRow,
  input: FilterInput,
): { ok: true } | { ok: false; reason: FilterReason } {
  if (!row.sceneTags.some((tag) => input.domains.includes(tag))) {
    return { ok: false, reason: 'scene' }
  }
  if (row.state !== 'active') return { ok: false, reason: 'state' }
  if (row.supersededBy !== null) return { ok: false, reason: 'superseded' }
  if (row.validTo !== null && row.validTo <= input.nowIso) {
    return { ok: false, reason: 'valid_to' }
  }
  // 保留期（`retention_basis.max_retention_days`）。
  //
  // 这条容易被漏：词表里写着 `card_state` 只留 90 天，如果不在这里判，那张表就只是一张
  // 说明书——记忆永远不会过期。`valid_to` 是"业务上失效"，保留期是"合规上到期"，两者
  // 独立，缺一条都算没兑现承诺。
  const basis = BASIS_BY_PREDICATE.get(row.predicate)
  if (basis !== undefined) {
    const expiresAt = Date.parse(row.validFrom) + basis.maxRetentionDays * 86_400_000
    if (Number.isFinite(expiresAt) && expiresAt <= Date.parse(input.nowIso)) {
      return { ok: false, reason: 'retention' }
    }
  }
  if (row.sensitivity > input.sensitivityCeiling) {
    // fail-closed：权限矩阵拿不准时宁可不召回，也不越权装配。
    return { ok: false, reason: 'sensitivity' }
  }
  return { ok: true }
}

export function applyFilter(input: FilterInput): FilterOutcome {
  const retrieved: string[] = []
  const filteredOut: { unitId: string; reason: FilterReason }[] = []
  const passed: MemoryUnitRow[] = []

  for (const row of input.rows) {
    const verdict = judge(row, input)
    if (verdict.ok) {
      retrieved.push(row.unitId)
      passed.push(row)
    } else {
      if (verdict.reason !== 'scene') retrieved.push(row.unitId)
      filteredOut.push({ unitId: row.unitId, reason: verdict.reason })
    }
  }

  // 排序：置信度优先，其次新的在前（时近性）。截断掉的合法行**不记** filteredOut——
  // 它们是"没装下"，不是"被拒"，混在一起会让原因统计失去意义。
  const sorted = [...passed].sort((left, right) => {
    if (right.confidence !== left.confidence) return right.confidence - left.confidence
    return right.validFrom < left.validFrom ? -1 : right.validFrom > left.validFrom ? 1 : 0
  })

  return { retrieved, filteredOut, selected: sorted.slice(0, input.maxK) }
}

/** 从存储取行再过滤的便捷封装（store 只取数，判决仍在本文件）。 */
export function readScoped(
  store: MemoryStore,
  tenant: string,
  userId: string,
  input: Omit<FilterInput, 'rows'>,
): FilterOutcome {
  return applyFilter({ ...input, rows: store.listUnits(tenant, userId) })
}
