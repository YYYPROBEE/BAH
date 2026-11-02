/**
 * `node:sqlite` 的加载口（SA-07 §11）。
 *
 * Node 22.x 在**模块求值时**打印 `ExperimentalWarning: SQLite is an experimental feature`。
 * BAH 已在 SA-00 §6 明确接受该实验性状态，但它会污染 CLI 的 stderr（`--help` 也要求 stderr 干净）。
 * 这里只在**加载瞬间**过滤这一条已知提示，随后立刻恢复原处理器——其余警告照常输出。
 */

import { createRequire } from 'node:module'

import type * as Sqlite from 'node:sqlite'

const require = createRequire(import.meta.url)

let cached: typeof Sqlite | undefined

/** 加载（并缓存）`node:sqlite`，过滤已知的实验性提示。 */
export function loadSqlite(): typeof Sqlite {
  if (cached !== undefined) return cached

  const original = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message
    if (message.includes('SQLite is an experimental feature')) return
    ;(original as (...args: unknown[]) => void).apply(process, [warning, ...rest])
  }) as typeof process.emitWarning

  try {
    cached = require('node:sqlite') as typeof Sqlite
    return cached
  } finally {
    process.emitWarning = original
  }
}
