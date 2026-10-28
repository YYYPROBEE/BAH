/**
 * 租户目录布局（租户与鉴权 01 · TA-12）。
 *
 * 判据只有一句：**`fileOf` 的第一段路径是租户**。这一条守不住，后面所有"按租户列痕迹"
 * 的能力（审计、清理、迁移）都是假的。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'
import { parseTenantId } from '@bah/util'

import { boot } from '../boot.ts'
import { createCatalog } from './index.ts'
import { SESSION_FILES, tenantRootOf } from './persistence.ts'
import { testRunContext } from '../test-run-context.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-tenant-layout-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 只装持久化一行（布局是它的职责，别的插件不参与）。 */
async function bootPersistence(jsonlDir: string, tenant: string) {
  return boot({
    profile: { name: 'fx-layout', bundles: ['fx-layout'], hmr: false },
    bundles: [{ name: 'fx-layout', rows: [{ id: 'core:persistence', config: {} }] }],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({ tenantId: parseTenantId(tenant), jsonlDir }),
  })
}

describe('tenantRootOf', () => {
  it('TA-12-1 租户根 = 部署根 + 租户段（唯一实现，别处不许再拼）', () => {
    expect(tenantRootOf('sessions', parseTenantId('demo'))).toBe(join('sessions', 'demo'))
    expect(tenantRootOf('sessions', parseTenantId('acme-bank'))).toBe(join('sessions', 'acme-bank'))
  })

  it('TA-12-2 绕过 parseTenantId 的非法租户在拼路径前被拒（asTenantId 的兜底）', () => {
    // 模拟调用方用无校验的 asTenantId 塞了穿越串
    expect(() => tenantRootOf('sessions', '../etc' as never)).toThrow(/路径段/)
  })
})

describe('SessionFiles · 租户化之后', () => {
  it('TA-12-3 root 是租户根；fileOf 的首段是租户 ID', async () => {
    const dir = tempDir()
    const app = await bootPersistence(dir, 'acme-bank')
    try {
      const files = app.ctx.get(SESSION_FILES)
      expect(files.root).toBe(join(dir, 'acme-bank'))
      expect(files.baseRoot).toBe(dir)
      expect(String(files.tenantId)).toBe('acme-bank')
      expect(files.fileOf(asSessionId('s-1'))).toBe(
        join(dir, 'acme-bank', 's-1', 'session.jsonl'),
      )
    } finally {
      await app.dispose('test')
    }
  })

  it('TA-12-4 两个租户的会话目录集合不相交（同 sessionId 也不撞）', async () => {
    const dir = tempDir()
    const demo = await bootPersistence(dir, 'demo')
    const acme = await bootPersistence(dir, 'acme')
    try {
      const demoPath = demo.ctx.get(SESSION_FILES).fileOf(asSessionId('s-same'))
      const acmePath = acme.ctx.get(SESSION_FILES).fileOf(asSessionId('s-same'))
      expect(demoPath).not.toBe(acmePath)
      expect(demoPath.startsWith(join(dir, 'demo'))).toBe(true)
      expect(acmePath.startsWith(join(dir, 'acme'))).toBe(true)
    } finally {
      await demo.dispose('test')
      await acme.dispose('test')
    }
  })
})
