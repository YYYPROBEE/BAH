/**
 * 记忆库的租户隔离（租户与鉴权 01 · TA-13）。
 *
 * 两件事：
 * 1. **落点**：同进程两个 boot（不同租户）→ 两个独立库文件（`<root>/<tenant>/memory.db`）；
 * 2. **数据**：A 库里查不到 B 的行——"隔离"不是文件分开就自动成立的，SQL 全路径也得带租户。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createMemoryLayer } from '@bah/memory-store'
import { asSessionId } from '@bah/test-support'
import { parseTenantId } from '@bah/util'

import { boot } from '../boot.ts'
import { createCatalog } from './index.ts'
import { testRunContext } from '../test-run-context.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-memory-tenant-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 起一个只装 persistence + memory 的应用（不跑 turn，只看装配与落点）。 */
async function bootMemory(jsonlDir: string, tenant: string) {
  return boot({
    profile: { name: 'fx-memory-tenant', bundles: ['fx-memory-tenant'], hmr: false },
    bundles: [
      {
        name: 'fx-memory-tenant',
        rows: [
          { id: 'core:session' },
          { id: 'core:prompt' },
          { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
          { id: 'bah:memory-store', config: { dbPath: 'memory.db', userId: 'u-1' } },
        ],
      },
    ],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({ sessionId: asSessionId('s-mem'), tenantId: parseTenantId(tenant), jsonlDir }),
  })
}

describe('记忆库按租户', () => {
  it('TA-13-1 两个租户 → 两个独立库文件（<root>/<tenant>/memory.db）', async () => {
    const dir = tempDir()
    const demo = await bootMemory(dir, 'demo')
    const acme = await bootMemory(dir, 'acme')
    try {
      expect(existsSync(join(dir, 'demo', 'memory.db'))).toBe(true)
      expect(existsSync(join(dir, 'acme', 'memory.db'))).toBe(true)
      expect(existsSync(join(dir, 'memory.db'))).toBe(false)
    } finally {
      await demo.dispose('test')
      await acme.dispose('test')
    }
  })

  it('TA-13-2 A 库里查不到 B 的行（SQL 全路径带 tenant）', async () => {
    const dir = tempDir()
    const now = () => 1_700_000_000_000
    // 与插件一致：目录由宿主侧保证存在（租户根是 mkdir -p 出来的）
    mkdirSync(join(dir, 'demo'), { recursive: true })
    mkdirSync(join(dir, 'acme'), { recursive: true })
    const demoLayer = createMemoryLayer({ dbPath: join(dir, 'demo', 'memory.db'), now })
    const acmeLayer = createMemoryLayer({ dbPath: join(dir, 'acme', 'memory.db'), now })
    try {
      await demoLayer.ingestTurn({
        tenant: 'demo',
        user_id: 'u-1',
        session_id: 's-1',
        turn_id: 1,
        scene: 'transfer',
        speaker: 'user',
        text: '以后转账都用尾号8888的卡',
      })
      expect(demoLayer.store.listUnits('demo', 'u-1').length).toBeGreaterThan(0)
      // 跨租户查询：同一份数据里没有别的租户的行
      expect(demoLayer.store.listUnits('acme', 'u-1')).toHaveLength(0)
      expect(acmeLayer.store.listUnits('demo', 'u-1')).toHaveLength(0)
    } finally {
      demoLayer.close()
      acmeLayer.close()
    }
  })
})
