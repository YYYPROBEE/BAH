/**
 * `bank:saga-store` 的配置与装配兜底。
 *
 * 两条兜底都不在 happy path 上，但都会在真实部署里生效：
 * - `:memory:` 必须被当成 SQLite 的内存库，而不是被 `resolve()` 拼成磁盘路径
 *   （Windows 下 `:memory:` 是非法文件名，拼错会直接开库失败）；
 * - 未配 `dbPath` 时落到缺省文件名，而不是 `undefined` 让下游崩。
 */

import { createContext } from '@bah/core'
import { SAGA_STORE, TARGET_REGISTRY } from '@bah/saga'
import { describe, expect, it } from 'vitest'

import { sagaStorePlugin } from './saga-store.ts'

describe('bank:saga-store 配置校验', () => {
  it('未写 dbPath 时落缺省文件名', () => {
    expect(sagaStorePlugin.validate({})).toEqual({ dbPath: 'saga.sqlite' })
  })

  it('未知键 fail-loud', () => {
    expect(() => sagaStorePlugin.validate({ dbPath: ':memory:', extra: 1 })).toThrow(/extra/)
  })
})

describe('bank:saga-store 装配', () => {
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
