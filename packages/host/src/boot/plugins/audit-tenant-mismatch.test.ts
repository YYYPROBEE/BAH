/**
 * 启动期链扫描的租户对账（租户与鉴权 01 · 复审 AR-02）。
 *
 * **威胁**：把 acme 的链目录整搬进 demo（`mv sessions/acme/s-1 sessions/demo/s-1`）。
 * 哈希链**仍然连续**（搬目录不改字节），`verifyAll()` 只验连续性 ⇒ 一条链在错误的租户下
 * 被当作"没问题"。`bah audit --tenant` 能发现，但那是事后人工命令，**启动期不响**。
 *
 * 这里钉住两件事：
 * 1. 外来租户的链行 → `verifyAll()` 必须报（`brokenAt` 指到具体条目）；
 * 2. 本租户的链 → 不许误报（否则每次启动都 HALT，等于制造新故障）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createSagaAudit } from '@bah/persistence'
import { asSessionId } from '@bah/test-support'
import { parseTenantId } from '@bah/util'

import { boot } from '../boot.ts'
import { createCatalog } from './index.ts'
import { DECISION_AUDIT } from './audit-decisions.ts'
import { testRunContext } from '../test-run-context.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-audit-tenant-mix-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 在"部署根"的某个租户目录下造一条链。 */
function makeChain(deployRoot: string, dirTenant: string, sagaId: string, rowTenant: string): void {
  const writer = createSagaAudit({
    now: () => 1_700_000_000_000,
    rootDir: join(deployRoot, dirTenant),
    fsync: false,
    signedTypes: [],
    warn: () => undefined,
    tenant: rowTenant,
  })
  writer.append(sagaId, 'tool/call', { callId: 'call-1' })
}

/** 起一个只有 session + persistence + audit:decisions 的应用。 */
async function bootAudit(deployRoot: string, tenant: string) {
  return boot({
    profile: { name: 'fx-audit-tenant', bundles: ['fx-audit-tenant'], hmr: false },
    bundles: [
      {
        name: 'fx-audit-tenant',
        rows: [
          { id: 'core:session' },
          { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
          {
            id: 'audit:decisions',
            config: { signingKeyPath: join(deployRoot, 'no-such-key.pem') },
          },
        ],
      },
    ],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId('s-tenant-check'),
      tenantId: parseTenantId(tenant),
      jsonlDir: deployRoot,
    }),
    warn: () => undefined,
  })
}

describe('verifyAll · 租户对账', () => {
  it('AR-02-1 链行租户与目录租户不一致 → 报出来，并指到具体条目', async () => {
    const root = tempDir()
    // 模拟"acme 的链被搬进 demo"：目录在 demo 下，行里写的是 acme
    makeChain(root, 'demo', 's-moved', 'acme')
    const app = await bootAudit(root, 'demo')
    try {
      const breaks = app.ctx.get(DECISION_AUDIT).verifyAll()
      expect(breaks).toHaveLength(1)
      expect(breaks[0]?.chainId).toBe('s-moved')
      expect(breaks[0]?.brokenAt).toBe(1)
      expect(breaks[0]?.error).toContain('租户')
    } finally {
      await app.dispose('test')
    }
  })

  it('AR-02-2 本租户的链不误报（历史行没有 tenant 也照样通过）', async () => {
    const root = tempDir()
    makeChain(root, 'demo', 's-own', 'demo')
    // 再造一条"历史链"（没有 tenant 字段）
    const legacy = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: join(root, 'demo'),
      fsync: false,
      signedTypes: [],
      warn: () => undefined,
    })
    legacy.append('s-legacy', 'tool/call', { callId: 'call-legacy' })

    const app = await bootAudit(root, 'demo')
    try {
      expect(app.ctx.get(DECISION_AUDIT).verifyAll()).toEqual([])
    } finally {
      await app.dispose('test')
    }
  })
})
