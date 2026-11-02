/**
 * 迁移链（SA-07 §3.1）：单调 `SCHEMA_VERSION`，每个相邻版本一个迁移包。
 *
 * 当前只有 v0；打开已有库时只在版本相等时放行，未来版本一律拒绝（T-SA07-004）。
 */

import { BahError } from '@bah/util'

import { applyV0, CURRENT_SCHEMA_VERSION, existingTables } from './v0_init.ts'

import type { DatabaseSync } from 'node:sqlite'

export { applyV0, CURRENT_SCHEMA_VERSION, V0_BUSINESS_TABLES } from './v0_init.ts'

/**
 * 把库迁移到当前版本（空库执行 v0；当前版本 no-op）。
 *
 * @throws `BahError('schema-version-too-new')` 库版本高于当前代码
 * @throws `BahError('schema-version-unsupported')` 库版本低于当前代码但没有迁移路径
 */
export function migrate(db: DatabaseSync): void {
  const tables = existingTables(db)
  if (!tables.includes('schema_migrations')) {
    applyV0(db)
    return
  }

  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number | null } | undefined
  const version = row?.version ?? 0

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new BahError(
      'schema-version-too-new',
      `bah-saga: schema-version-too-new: 库版本 ${version} 高于当前代码支持的 ${CURRENT_SCHEMA_VERSION}，拒绝打开`,
      { version, supported: CURRENT_SCHEMA_VERSION },
    )
  }
  if (version < CURRENT_SCHEMA_VERSION) {
    throw new BahError(
      'schema-version-unsupported',
      `bah-saga: schema-version-unsupported: 库版本 ${version} 缺少到 ${CURRENT_SCHEMA_VERSION} 的迁移路径`,
      { version, supported: CURRENT_SCHEMA_VERSION },
    )
  }
}
