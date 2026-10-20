/**
 * T-SA07-006：`bank:saga-store` + `bank:saga` + `bank:saga-audit` 三插件装配。
 *
 * 装配成功即证明：无 `inject` 环、时钟由 saga 提供、审计插件等时钟就绪、存储服务可 get。
 * 审计链落到 `sessions/`，本用例用唯一 sagaId 并在收尾清理。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_IDEMPOTENCY, SAGA_STORE, TARGET_REGISTRY } from '@bah/saga'
import { describe, expect, it } from 'vitest'

import { SESSION_FILES } from './persistence.ts'
import { sagaPlugin } from './saga.ts'
import { sagaAuditPlugin } from './saga-audit.ts'
import { sagaStorePlugin } from './saga-store.ts'

import type { Context, ServiceKey } from '@bah/core'

/** `ctx.get` 未注册服务必须抛 `service-missing`。 */
function expectServiceMissing<T>(ctx: Context, key: ServiceKey<T>): void {
  try {
    ctx.get(key)
    expect.unreachable(`${key.id} 不应可读`)
  } catch (error) {
    expect((error as { code?: string }).code).toBe('service-missing')
  }
}

describe('Saga 三插件装配', () => {
  it('T-SA07-006：apply 空跑装配成功，三个服务键就绪，dispose 后可逆', async () => {
    const ctx = createContext()
    const sagaId = `s1-test-${process.pid}-${Date.now()}`
    const chainRoot = mkdtempSync(join(tmpdir(), 'bah-saga-host-'))
    try {
      ctx.provide(SESSION_FILES, {
        root: chainRoot,
        fileOf: (session) => join(chainRoot, String(session), 'session.jsonl'),
      })
      await ctx.use(sagaStorePlugin.plugin, sagaStorePlugin.validate({ dbPath: ':memory:' }))
      await ctx.use(sagaPlugin.plugin, sagaPlugin.validate({}))
      await ctx.use(sagaAuditPlugin.plugin, sagaAuditPlugin.validate({}))

      await ctx.start()

      expect(ctx.get(SAGA_STORE)).toBeDefined()
      expect(typeof ctx.get(SAGA_CLOCK).now()).toBe('number')
      expect(typeof ctx.get(SAGA_AUDIT).append).toBe('function')
      expect(typeof ctx.get(SAGA_IDEMPOTENCY).makeKey).toBe('function')

      // SA-16 §8：目标登记的生产提供者已就位（不再是 service-missing）。
      const store = ctx.get(SAGA_STORE)
      store.upsertTarget({
        targetSystem: 'pay.charge',
        idempotencySupport: 'STRONG',
        probeEndpoint: '/probe/pay',
        lagSeconds: 0,
        registeredAt: 1,
      })
      expect(ctx.get(TARGET_REGISTRY).get('pay.charge')?.idempotencySupport).toBe('STRONG')
      expect(ctx.get(TARGET_REGISTRY).list()).toHaveLength(1)

      // 审计插件确实拿到的是 saga 提供的时钟：同一 now 源
      const before = ctx.get(SAGA_CLOCK).now()
      const appended = ctx.get(SAGA_AUDIT).append(sagaId, 'saga/created', { sagaId })
      expect(appended.seqInSaga).toBe(1)
      expect(ctx.get(SAGA_CLOCK).now()).toBeGreaterThanOrEqual(before)
      expect(ctx.get(SAGA_AUDIT).verify(sagaId)).toEqual({ ok: true })
    } finally {
      await ctx.dispose('test')
      expectServiceMissing(ctx, SAGA_STORE)
      expectServiceMissing(ctx, SAGA_CLOCK)
      expectServiceMissing(ctx, SAGA_AUDIT)
      expectServiceMissing(ctx, SAGA_IDEMPOTENCY)
      rmSync(chainRoot, { recursive: true, force: true })
    }
  })
})
