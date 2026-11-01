/**
 * 层序合并器。
 *
 * 四层，后层覆盖前层：
 * ```text
 * profile bundles → profile patch.yml → home patch → --patch overlay
 * ```
 *
 * **语义只有两种**：
 * 1. `id` 命中 → **整块替换** `config`（不深合并；未写字段由插件默认值兜底）；
 * 2. `id` 未命中 → 插入新行（必须写 `use`，指向依赖清单里的插件实现）。
 *
 * 为什么坚持整块替换：深合并会让"我到底改了哪些字段"从配置上读不出来，
 * 出事故时无法用一份 patch 文件解释线上状态。
 */

import { bootError } from './config.ts'

/** 来源层（`dump-config` 的"来源层标注"与 HMR 的"谁改了它"都靠它）。 */
export type SourceLayer = 'bundle' | 'profile-patch' | 'home-patch' | 'overlay'

/** 一行的写法（bundle 行与 patch 行同形；`use` 缺省时等于 `id`）。 */
export interface PluginRow {
  /** 行 id：patch 的定位键，全局唯一。 */
  readonly id: string
  /** 插件实现 id（依赖清单里的名字）；插入新行时必填。 */
  readonly use?: string
  /** 该行的配置（整块替换，不深合并）。 */
  readonly config?: Readonly<Record<string, unknown>>
}

/** bundle 行（bundle 数据由 `packages/cli/bundles/<name>/` 提供）。 */
export type BundleRow = PluginRow

/** 一个 bundle：名字 + 它带进来的行。 */
export interface Bundle {
  readonly name: string
  readonly rows: readonly BundleRow[]
}

/** 一层 patch（已解析成行，`from` 是人可读的来源）。 */
export interface ConfigLayer {
  readonly layer: SourceLayer
  readonly from: string
  readonly rows: readonly PluginRow[]
}

/** 合并结果：某一行在某一层被最终定稿。 */
export interface ResolvedRow {
  readonly id: string
  readonly use: string
  readonly config: Readonly<Record<string, unknown>>
  readonly layer: SourceLayer
  readonly from: string
}

/**
 * 按层序合并出最终行集合。
 *
 * @param bundles 按 profile 声明顺序排好的 bundle
 * @param layers 按层序排好的 patch 层（profile patch → home patch → overlay）
 * @throws `BahError('empty-bundle')` bundle 没有任何行
 * @throws `BahError('invalid-row')` 行缺 id / use、或 config 不是对象
 * @throws `BahError('duplicate-row')` 同一 bundle 或同一层内 id 重复
 * @throws `BahError('row-without-plugin')` 插入新行却没写 `use`
 */
export function mergeLayers(
  bundles: readonly Bundle[],
  layers: readonly ConfigLayer[],
): ResolvedRow[] {
  const rows: ResolvedRow[] = []
  const index = new Map<string, number>()

  for (const bundle of bundles) {
    if (bundle.rows.length === 0) {
      throw bootError('empty-bundle', `bundle ${bundle.name} 没有任何插件行（空组合没有意义）`, {
        bundle: bundle.name,
      })
    }
    const seen = new Set<string>()
    for (const row of bundle.rows) {
      const normalized = normalizeRow(row, `bundle ${bundle.name}`)
      if (seen.has(normalized.id)) {
        throw bootError(
          'duplicate-row',
          `bundle ${bundle.name} 内 id ${normalized.id} 重复（同一层不允许两行同 id）`,
          { bundle: bundle.name, id: normalized.id },
        )
      }
      seen.add(normalized.id)
      push(rows, index, {
        id: normalized.id,
        use: normalized.use ?? normalized.id,
        config: normalized.config ?? {},
        layer: 'bundle',
        from: bundle.name,
      })
    }
  }

  for (const layer of layers) {
    const seen = new Set<string>()
    for (const raw of layer.rows) {
      const row = normalizeRow(raw, `层 ${layer.from}`)
      if (seen.has(row.id)) {
        throw bootError('duplicate-row', `层 ${layer.from} 内 id ${row.id} 重复`, {
          layer: layer.from,
          id: row.id,
        })
      }
      seen.add(row.id)

      const at = index.get(row.id)
      if (at === undefined) {
        if (row.use === undefined) {
          throw bootError(
            'row-without-plugin',
            `层 ${layer.from} 的行 ${row.id} 是新插入行，必须写 use（指向依赖清单里的插件）`,
            { layer: layer.from, id: row.id },
          )
        }
        push(rows, index, {
          id: row.id,
          use: row.use,
          config: row.config ?? {},
          layer: layer.layer,
          from: layer.from,
        })
        continue
      }

      // 整块替换：不保留旧 config 的任何字段（未写字段交给插件默认值）
      rows[at] = {
        id: row.id,
        use: row.use ?? rows[at]!.use,
        config: row.config ?? {},
        layer: layer.layer,
        from: layer.from,
      }
    }
  }

  return rows
}

/**
 * 行结构校验：id 必填非空、use 非空（若写）、config 必须是对象。
 *
 * @throws `BahError('invalid-row')`
 */
export function normalizeRow(row: PluginRow, where: string): PluginRow {
  if (typeof row.id !== 'string' || row.id.trim().length === 0) {
    throw bootError('invalid-row', `${where} 的行缺少 id（patch 靠 id 定位，必填）`, { where })
  }
  if (row.use !== undefined && (typeof row.use !== 'string' || row.use.trim().length === 0)) {
    throw bootError('invalid-row', `${where} 的行 ${row.id} 的 use 必须是非空字符串`, {
      where,
      id: row.id,
    })
  }
  if (row.config !== undefined && (typeof row.config !== 'object' || row.config === null || Array.isArray(row.config))) {
    throw bootError('invalid-row', `${where} 的行 ${row.id} 的 config 必须是对象`, {
      where,
      id: row.id,
    })
  }
  return {
    id: row.id.trim(),
    ...(row.use === undefined ? {} : { use: row.use.trim() }),
    ...(row.config === undefined ? {} : { config: row.config }),
  }
}

/**
 * 结构是否一致（id 序列与 use 逐条相同）。
 *
 * 不一致 = 插件行有增删改指向，config-only HMR 不处理（需重启， 第 3 行）。
 */
export function sameStructure(
  previous: readonly ResolvedRow[],
  next: readonly ResolvedRow[],
): boolean {
  if (previous.length !== next.length) return false
  return previous.every((row, index) => {
    const other = next[index]
    return other !== undefined && other.id === row.id && other.use === row.use
  })
}

/**
 * 配置发生变化的行 id（顺序与 `next` 一致；无变化返回空数组）。
 *
 * 比较用**键序归一化**后的 JSON：YAML 里调换字段顺序不算改动。
 */
export function diffRows(
  previous: readonly ResolvedRow[],
  next: readonly ResolvedRow[],
): readonly string[] {
  const before = new Map(previous.map((row) => [row.id, stableConfig(row.config)]))
  const changed: string[] = []
  for (const row of next) {
    const old = before.get(row.id)
    if (old !== undefined && old !== stableConfig(row.config)) changed.push(row.id)
  }
  return changed
}

/** 键序归一化的配置 JSON（顶层键排序，值原样）。 */
function stableConfig(config: Readonly<Record<string, unknown>>): string {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(config).sort()) sorted[key] = config[key]
  return JSON.stringify(sorted)
}

/** 追加并登记 id 下标（重复 id 由调用方先行判定）。 */
function push(rows: ResolvedRow[], index: Map<string, number>, row: ResolvedRow): void {
  index.set(row.id, rows.length)
  rows.push(row)
}
