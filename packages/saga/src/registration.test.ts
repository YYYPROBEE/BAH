/**
 * T-SA07-005 / T-SA07-009：服务未注册 fail-loud；provide 可逆。
 */

import { createTestContext } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { provideSaga } from './index.ts'
import { SAGA_CLOCK, SAGA_STORE } from './seams.ts'
import { parseSagaSettings } from './settings.ts'

import type { Context, ServiceKey } from '@bah/core'

/** `ctx.get` 未注册服务必须抛 `service-missing`（reason code 在 error.code 上）。 */
function expectServiceMissing<T>(ctx: Context, key: ServiceKey<T>): void {
  try {
    ctx.get(key)
    expect.unreachable(`${key.id} 不应可读`)
  } catch (error) {
    expect((error as { code?: string }).code).toBe('service-missing')
  }
}

describe('服务键与可逆注册', () => {
  it('T-SA07-005：未注册的 SAGA_STORE 抛 service-missing（不返回 undefined）', async () => {
    const test = createTestContext()
    await test.start()
    try {
      expectServiceMissing(test.ctx, SAGA_STORE)
    } finally {
      await test.dispose()
    }
  })

  it('T-SA07-009：provideSaga 注册时钟；dispose 后服务消失', async () => {
    const test = createTestContext()
    await test.start()
    provideSaga(test.ctx, parseSagaSettings({}))

    const clock = test.ctx.get(SAGA_CLOCK)
    expect(typeof clock.now()).toBe('number')

    await test.dispose('test')
    expectServiceMissing(test.ctx, SAGA_CLOCK)
  })
})
