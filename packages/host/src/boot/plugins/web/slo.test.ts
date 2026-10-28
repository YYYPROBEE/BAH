import { describe, expect, it } from 'vitest'

import type { Context } from '@bah/core'
import type { SagaSettings } from '@bah/saga'

import { SAGA_SETTINGS } from '../saga.ts'
import { readSlo, sloReader } from './slo.ts'

/** 最小 Context 桩：只实现 `get`，按服务键返回或抛。 */
function fakeContext(settings: SagaSettings | undefined): Context {
  return {
    get(key: { id: string }) {
      if (settings !== undefined && key === SAGA_SETTINGS) return settings
      throw new Error(`service ${String(key.id)} missing`)
    },
  } as unknown as Context
}

const SETTINGS = {
  softSlaMs: 30_000,
  hardSlaMs: 60_000,
  dlqAlertDepth: 1,
  dlqPhoneDepth: 3,
} as unknown as SagaSettings

describe('web · SLO 桥', () => {
  it('没装 saga → undefined（不是空对象，也不是报错）', () => {
    expect(readSlo(fakeContext(undefined))).toBeUndefined()
    expect(sloReader(fakeContext(undefined))()).toBeUndefined()
  })

  it('装了 saga 但存储不可用 → 求值失败也返回 undefined（fail-open）', () => {
    expect(readSlo(fakeContext(SETTINGS))).toBeUndefined()
  })
})
