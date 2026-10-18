/**
 * 服务接缝单测（施工单 02 §5 / §10）。
 *
 * 覆盖：按键寻址、`get` fail-loud、`whenReady` waiting 队列、重复 provide 的 misconfiguration。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { defineService, ServiceRegistry } from './service.ts'

describe('defineService', () => {
  it('服务键以 id 作为运行时键', () => {
    expect(defineService<string>('bank:model').id).toBe('bank:model')
  })

  it('空服务键载入即抛（inject 永远等不到它）', () => {
    expect(() => defineService<string>('')).toThrow(/服务键名不能为空/)
    expect(() => defineService<string>('')).toThrow(/bah-core: /)
  })
})

describe('ServiceRegistry', () => {
  it('T-CORE-017 get 未注册服务 → 抛错，不返回 undefined', () => {
    const services = new ServiceRegistry()
    const model = defineService<string>('bank:model')

    expect(services.has('bank:model')).toBe(false)
    try {
      services.get(model)
      expect.unreachable('get 未注册服务必须抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(BahError)
      expect((error as BahError).code).toBe('service-missing')
    }
  })

  it('whenReady 在 provide 之前挂起，provide 后全部等待者 resolve', async () => {
    const services = new ServiceRegistry()
    const limit = defineService<number>('bank:limit')

    const first = services.whenReady(limit)
    const second = services.whenReady(limit)
    expect(services.has('bank:limit')).toBe(false)

    services.provide(limit, 42)

    await expect(first).resolves.toBe(42)
    await expect(second).resolves.toBe(42)
    expect(services.has('bank:limit')).toBe(true)
  })

  it('whenReady 对已就绪服务立即 resolve', async () => {
    const services = new ServiceRegistry()
    const limit = defineService<number>('bank:limit')
    services.provide(limit, 7)

    await expect(services.whenReady(limit)).resolves.toBe(7)
  })

  it('同名 key 注销前重复 provide 属 misconfiguration，载入即抛', () => {
    const services = new ServiceRegistry()
    const limit = defineService<number>('bank:limit')
    services.provide(limit, 1)

    try {
      services.provide(limit, 2)
      expect.unreachable('重复 provide 必须抛错')
    } catch (error) {
      expect((error as BahError).code).toBe('service-conflict')
    }
  })

  it('注销句柄幂等，注销后可重新 provide', () => {
    const services = new ServiceRegistry()
    const limit = defineService<number>('bank:limit')
    const off = services.provide(limit, 1)

    off()
    off()
    expect(services.has('bank:limit')).toBe(false)

    services.provide(limit, 2)
    expect(services.get(limit)).toBe(2)
  })
})
