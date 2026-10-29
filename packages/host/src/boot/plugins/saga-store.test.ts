/**
 * `bank:saga-store` 的配置与装配兜底。
 *
 * 两条兜底都不在 happy path 上，但都会在真实部署里生效：
 * - `:memory:` 必须被当成 SQLite 的内存库，而不是被 `resolve()` 拼成磁盘路径
 *   （Windows 下 `:memory:` 是非法文件名，拼错会直接开库失败）；
 * - 未配 `dbPath` 时落到缺省文件名，而不是 `undefined` 让下游崩。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import { SAGA_STORE, TARGET_REGISTRY } from '@bah/saga'
import { describe, expect, it } from 'vitest'

import { SESSION_FILES } from './persistence.ts'
import { sagaStorePlugin } from './saga-store.ts'
import { DEFAULT_TENANT_ID, parseTenantId } from '@bah/util'

describe('bank:saga-store 配置校验', () => {
  it('未写 dbPath 时落缺省文件名', () => {
    expect(sagaStorePlugin.validate({})).toEqual({ dbPath: 'saga.sqlite' })
  })

  it('未知键 fail-loud', () => {
    expect(() => sagaStorePlugin.validate({ dbPath: ':memory:', extra: 1 })).toThrow(/extra/)
  })
})

describe('bank:saga-store 装配', () => {
  it('相对 dbPath 跟随会话根目录，并自建尚未存在的父目录', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bah-saga-store-'))
    const root = join(base, 'nested')
    const ctx = createContext()
    try {
      ctx.provide(SESSION_FILES, {
        root,
        baseRoot: root,
        tenantId: DEFAULT_TENANT_ID,
        fileOf: (session) => join(root, String(session), 'session.jsonl'),
      })
      await ctx.use(sagaStorePlugin.plugin, sagaStorePlugin.validate({}))
      await ctx.start()

      expect(existsSync(join(root, 'saga.sqlite'))).toBe(true)
    } finally {
      await ctx.dispose('test')
      rmSync(base, { recursive: true, force: true })
    }
  })

  it(':memory: 走内存库，不被拼成磁盘路径', async () => {
    const ctx = createContext()
    await ctx.use(sagaStorePlugin.plugin, sagaStorePlugin.validate({ dbPath: ':memory:' }))
    await ctx.start()

    // 能开库即证明走的是内存分支：若被 resolve() 成 `.../:memory:`，sqlite 会打开失败。
    expect(typeof ctx.get(SAGA_STORE).tx).toBe('function')
    // SA-16 §8：目标登记的生产提供者也要在位，否则补偿路径会 service-missing。
    expect(ctx.get(TARGET_REGISTRY).list()).toEqual([])

    await ctx.dispose('test')
  })
})

describe('04 §1.1 · saga.sqlite 创建者标记', () => {
  it('首次启动写 saga.tenant；同租户重启静默；异租户/缺标记各告警一行', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bah-saga-marker-'))
    const root = join(base, 'deploy')
    const warnings: string[] = []
    const original = console.error
    // 可观测性 02 起告警走 `logJson`（console.error 一行 JSON），不再是散文式 console.warn
    console.error = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '))
    }
    const bootTenant = async (tenant: string): Promise<void> => {
      const ctx = createContext()
      ctx.provide(SESSION_FILES, {
        root: join(root, tenant),
        baseRoot: root,
        tenantId: parseTenantId(tenant),
        fileOf: (session) => join(root, tenant, String(session), 'session.jsonl'),
      })
      await ctx.use(sagaStorePlugin.plugin, sagaStorePlugin.validate({}))
      await ctx.start()
      await ctx.dispose('test')
    }
    try {
      await bootTenant('demo')
      expect(existsSync(join(root, 'saga.tenant'))).toBe(true)
      expect(warnings).toEqual([])

      await bootTenant('demo')
      expect(warnings).toEqual([])

      await bootTenant('acme')
      const mismatch = warnings.join('\n')
      expect(mismatch).toContain('bank.saga-store-tenant-mismatch')
      expect(mismatch).toContain('"tenantId":"acme"')
      expect(mismatch).toContain('"owner":"demo"')

      rmSync(join(root, 'saga.tenant'), { force: true })
      warnings.length = 0
      await bootTenant('acme')
      const unmarked = warnings.join('\n')
      expect(unmarked).toContain('bank.saga-store-tenant-unmarked')
      expect(unmarked).toContain('"tenantId":"acme"')
    } finally {
      console.error = original
      rmSync(base, { recursive: true, force: true })
    }
  })
})
