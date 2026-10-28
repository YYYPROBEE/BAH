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
import { ChainFile } from '@bah/persistence'
import {
  hasTickJob,
  SAGA_AUDIT,
  SAGA_CLOCK,
  SAGA_IDEMPOTENCY,
  SAGA_STORE,
  TARGET_REGISTRY,
  unregisterTickJob,
} from '@bah/saga'
import { BahError } from '@bah/util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

/* ────────────────────────────────────────────────────────────────────────────
 * B-2 / B-3：收敛 job 的归属与启动恢复的取消（C8）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 一次性宏任务屏障：让已排队的微任务（`Promise.all(...).then`）全部落地。 */
const settle = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 0)
  })

/** 可控 promise：取消用例靠它消除时序依赖，不赌微任务顺序。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Saga 收敛 job 的生命周期', () => {
  // tick 注册表是模块级单例：用例之间必须清干净，否则一个用例的残留会替另一个"充数"
  beforeEach(() => {
    for (const name of ['janitor', 'recon', 'anchor'] as const) unregisterTickJob(name)
  })
  afterEach(() => {
    for (const name of ['janitor', 'recon', 'anchor'] as const) unregisterTickJob(name)
  })

  it('T-SA07-007 同名替换后旧实例的 tick 任务不再残留（归属在 bank:saga 桶）', async () => {
    const ctx = createContext()
    const chainRoot = mkdtempSync(join(tmpdir(), 'bah-saga-scope-'))
    try {
      ctx.provide(SESSION_FILES, {
        root: chainRoot,
        fileOf: (session) => join(chainRoot, String(session), 'session.jsonl'),
      })
      await ctx.use(sagaStorePlugin.plugin, sagaStorePlugin.validate({ dbPath: ':memory:' }))
      await ctx.use(sagaPlugin.plugin, sagaPlugin.validate({}))
      await ctx.use(sagaAuditPlugin.plugin, sagaAuditPlugin.validate({}))
      await ctx.start()
      await settle()

      expect(hasTickJob('janitor')).toBe(true)
      expect(hasTickJob('recon')).toBe(true)

      // 换成一个关掉 b3 的同名插件：`installConvergence` 直接 return，不注册任何 job。
      // 于是「旧实例的 job 有没有被回滚」成为唯一变量——若新实例照常注册，
      // `jobs.set` 会覆盖同名项，新旧实现在 hasTickJob 上表现完全一致，测不出东西。
      await ctx.use(sagaPlugin.plugin, sagaPlugin.validate({ features: { b3: false } }))
      await settle()

      expect(hasTickJob('janitor')).toBe(false)
      expect(hasTickJob('recon')).toBe(false)
    } finally {
      await ctx.dispose('test')
      rmSync(chainRoot, { recursive: true, force: true })
    }
  })

  it('T-SA07-009 未被卸载时启动恢复照常执行（取消守卫不能把正常路径也关掉）', async () => {
    const app = createContext()
    const gate = deferred()
    const touched = { activeSagas: 0 }
    const store = {
      activeSagas: (): readonly string[] => {
        touched.activeSagas += 1
        return []
      },
      listSteps: (): readonly unknown[] => [],
    }
    const audit = { append: (): void => undefined }
    const ctx: Context = new Proxy(app, {
      get(target, prop) {
        if (prop === 'whenReady') return (): Promise<void> => gate.promise
        if (prop === 'get') {
          return (key: ServiceKey<unknown>): unknown => {
            if (key.id === SAGA_STORE.id) return store
            if (key.id === SAGA_AUDIT.id) return audit
            return target.get(key)
          }
        }
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (this: unknown) => unknown).bind(target) : value
      },
    })
    const chainRoot = mkdtempSync(join(tmpdir(), 'bah-saga-recover-'))
    try {
      ctx.provide(SESSION_FILES, {
        root: chainRoot,
        fileOf: (session) => join(chainRoot, String(session), 'session.jsonl'),
      })
      await sagaPlugin.plugin.apply(ctx, sagaPlugin.validate({}))

      gate.resolve()
      await settle()

      // 反向断言：卸载才取消。没有这条，"永远不恢复"也能让 T-SA07-008 通过。
      expect(touched.activeSagas).toBe(1)
    } finally {
      await ctx.dispose('test')
      rmSync(chainRoot, { recursive: true, force: true })
    }
  })

  it('T-SA07-010 启动恢复失败：stderr 留痕 + 链上留证（system-startup）', async () => {
    const app = createContext()
    const gate = deferred()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '))
    })
    const chainRoot = mkdtempSync(join(tmpdir(), 'bah-saga-rec-audit-'))
    // 真 store（`:memory:`）+ 真 audit（链落临时目录）；只让 SAGA_STORE 的读取失败。
    const ctx: Context = new Proxy(app, {
      get(target, prop) {
        if (prop === 'whenReady') return (): Promise<void> => gate.promise
        if (prop === 'get') {
          return (key: ServiceKey<unknown>): unknown => {
            if (key.id === SAGA_STORE.id) throw new BahError('service-missing', '模拟启动恢复失败')
            return target.get(key)
          }
        }
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (this: unknown) => unknown).bind(target) : value
      },
    })
    try {
      ctx.provide(SESSION_FILES, {
        root: chainRoot,
        fileOf: (session) => join(chainRoot, String(session), 'session.jsonl'),
      })
      sagaStorePlugin.plugin.apply(app, sagaStorePlugin.validate({ dbPath: ':memory:' }))
      await sagaPlugin.plugin.apply(ctx, sagaPlugin.validate({}))
      sagaAuditPlugin.plugin.apply(app, sagaAuditPlugin.validate({}))

      gate.resolve()
      await settle()

      // ① stderr 仍然有：审计是补充，不替代"立刻可见"
      //    D2 起是单行 JSON，断言按 code 而不是拼接文案
      expect(logs.join('\n')).toContain('saga-recovery-failed')
      // ② 链上有证：系统级事实落进独立链，且不入任何 saga 的链
      const rows = new ChainFile({ rootDir: chainRoot, fsync: false }).read('system-startup')
      expect(rows.map((row) => row.t)).toEqual(['saga/recovery-failed'])
      expect(app.get(SAGA_AUDIT).verify('system-startup').ok).toBe(true)
      // ③ 审计写失败不影响装配：插件已经装好，服务可读
      expect(app.get(SAGA_STORE)).toBeDefined()
    } finally {
      spy.mockRestore()
      await app.dispose('test')
      rmSync(chainRoot, { recursive: true, force: true })
    }
  })

  it('T-SA07-011 审计也不可用时：只留 stderr，不把记账失败升级成未处理拒绝', async () => {
    const app = createContext()
    const gate = deferred()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '))
    })
    const chainRoot = mkdtempSync(join(tmpdir(), 'bah-saga-rec-noaudit-'))
    const ctx: Context = new Proxy(app, {
      get(target, prop) {
        if (prop === 'whenReady') return (): Promise<void> => gate.promise
        if (prop === 'get') {
          return (key: ServiceKey<unknown>): unknown => {
            if (key.id === SAGA_STORE.id || key.id === SAGA_AUDIT.id) {
              throw new BahError('service-missing', '模拟恢复与审计同时不可用')
            }
            return target.get(key)
          }
        }
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (this: unknown) => unknown).bind(target) : value
      },
    })
    try {
      ctx.provide(SESSION_FILES, {
        root: chainRoot,
        fileOf: (session) => join(chainRoot, String(session), 'session.jsonl'),
      })
      await sagaPlugin.plugin.apply(ctx, sagaPlugin.validate({}))

      gate.resolve()
      await settle()

      expect(logs.join('\n')).toContain('saga-recovery-failed')
      // 兜底必须留痕：否则"记账失败"会静默变成"什么都没发生"
      expect(logs.join('\n')).toContain('host.saga-recovery-audit-failed')
      expect(app.phase).toBe('idle')
    } finally {
      spy.mockRestore()
      await app.dispose('test')
      rmSync(chainRoot, { recursive: true, force: true })
    }
  })

  it('T-SA07-008 插件卸载后启动恢复不再执行（whenReady 落地也不跑）', async () => {
    const app = createContext()
    const gate = deferred()
    const touched = { activeSagas: 0 }
    const store = {
      activeSagas: (): readonly string[] => {
        touched.activeSagas += 1
        return []
      },
      listSteps: (): readonly unknown[] => [],
    }
    // 审计也要给桩：`recoverAll` 的第一行是 `get(SAGA_STORE)` 紧接 `get(SAGA_AUDIT)`，
    // 只桩 store 的话它会在触达 `activeSagas` 探针前抛 service-missing——
    // 探针永远 0，负控就红不了（假绿）。
    const audit = { append: (): void => undefined }
    const logs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '))
    })
    // 只替换三个接缝：whenReady 由用例控制，get 的两个键换成探针。
    const ctx: Context = new Proxy(app, {
      get(target, prop) {
        if (prop === 'whenReady') return (): Promise<void> => gate.promise
        if (prop === 'get') {
          return (key: ServiceKey<unknown>): unknown => {
            if (key.id === SAGA_STORE.id) return store
            if (key.id === SAGA_AUDIT.id) return audit
            return target.get(key)
          }
        }
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? (value as (this: unknown) => unknown).bind(target) : value
      },
    })
    const chainRoot = mkdtempSync(join(tmpdir(), 'bah-saga-cancel-'))
    try {
      ctx.provide(SESSION_FILES, {
        root: chainRoot,
        fileOf: (session) => join(chainRoot, String(session), 'session.jsonl'),
      })
      await sagaPlugin.plugin.apply(ctx, sagaPlugin.validate({}))

      await ctx.dispose('test')
      gate.resolve()
      await settle()

      expect(touched.activeSagas).toBe(0)
      expect(logs).toEqual([])
    } finally {
      spy.mockRestore()
      rmSync(chainRoot, { recursive: true, force: true })
    }
  })
})
