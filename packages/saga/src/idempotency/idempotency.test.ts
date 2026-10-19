/**
 * T-SA09-001~004：幂等键、三结局、租约接管、同键异载。
 */


import { createContext } from '@bah/core'
import { createSagaStore } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { installIdempotency, makeKey, makeNonce } from './index.ts'
import { SAGA_CLOCK, SAGA_IDEMPOTENCY, SAGA_STORE } from '../seams.ts'

import type { Context } from '@bah/core'
import type { IdempotencyRecord } from '../types.ts'

const SAGA = 'saga-idem'
const STEP = 'step-1'

interface Harness {
  readonly ctx: Context
  readonly store: ReturnType<typeof createSagaStore>
  advance(ms: number): void
  idemRow(key: string): IdempotencyRecord | undefined
}

function harness(): Harness {
  let now = 1_000
  const store = createSagaStore({ dbPath: ':memory:', now: () => now })
  const ctx = createContext()
  ctx.provide(SAGA_STORE, store)
  ctx.provide(SAGA_CLOCK, { now: () => now, sleep: async () => undefined })
  installIdempotency(ctx)
  return {
    ctx,
    store,
    advance(ms) {
      now += ms
    },
    idemRow(key) {
      return store.tx((tx) => tx.readIdempotency(key))
    },
  }
}

function record(key: string, digest: string): IdempotencyRecord {
  return {
    idemKey: key,
    namespace: 'FWD',
    sagaId: SAGA,
    targetSystem: 'pay',
    requestDigest: digest,
    status: 'RESERVED',
  }
}

describe('幂等信封', () => {
  it('T-SA09-001：同键双发仅一方占位，网关调用计数 = 1', () => {
    const test = harness()
    const idem = test.ctx.get(SAGA_IDEMPOTENCY)
    const nonce = makeNonce()
    const key = makeKey('FWD', SAGA, STEP, nonce)

    let invokes = 0
    if (idem.reserve(key, record(key, 'req-1'), 60_000).ok) invokes += 1
    const second = idem.reserve(key, record(key, 'req-1'), 60_000)
    if (second.ok) invokes += 1

    expect(invokes).toBe(1)
    expect(second).toEqual({ ok: false, reason: 'lease-held' })
  })

  it('T-SA09-002：未持 nonce 者无法构造同键（HMAC 断言）', () => {
    const nonce = makeNonce()
    const real = makeKey('FWD', SAGA, STEP, nonce)
    const guessed = makeKey('FWD', SAGA, STEP, makeNonce())
    expect(guessed).not.toBe(real)

    // 同 (namespace, sagaId, localId) 换 nonce，键必变；换 namespace 再变。
    expect(makeKey('FWD', SAGA, STEP, nonce)).toBe(real)
    expect(makeKey('COMP', SAGA, STEP, nonce)).not.toBe(real)
    expect(real.startsWith('FWD:')).toBe(true)
    expect(real.slice(4)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('T-SA09-003：租约过期可接管，未过期 lease-held 且 owner 不变', () => {
    const test = harness()
    const idem = test.ctx.get(SAGA_IDEMPOTENCY)
    const key = makeKey('FWD', SAGA, STEP, makeNonce())

    expect(
      idem.reserve(key, { ...record(key, 'req-1'), leaseOwner: 'worker-a' }, 100),
    ).toEqual({ ok: true })

    // 未过期：拒绝，owner 保持 A。
    expect(idem.reserve(key, { ...record(key, 'req-1'), leaseOwner: 'worker-b' }, 100)).toEqual({
      ok: false,
      reason: 'lease-held',
    })
    expect(test.idemRow(key)?.leaseOwner).toBe('worker-a')

    // 过期：B 接管。
    test.advance(101)
    expect(idem.reserve(key, { ...record(key, 'req-1'), leaseOwner: 'worker-b' }, 100)).toEqual({
      ok: true,
    })
    expect(test.idemRow(key)?.leaseOwner).toBe('worker-b')
  })

  it('T-SA09-004：同键异载 → key-conflict，且不覆盖原行', () => {
    const test = harness()
    const idem = test.ctx.get(SAGA_IDEMPOTENCY)
    const key = makeKey('FWD', SAGA, STEP, makeNonce())

    expect(idem.reserve(key, record(key, 'req-1'), 60_000)).toEqual({ ok: true })
    expect(idem.reserve(key, record(key, 'req-2'), 60_000)).toEqual({
      ok: false,
      reason: 'key-conflict',
    })
    expect(test.idemRow(key)?.requestDigest).toBe('req-1')
  })

  it('tx 内版本可直接在提交段中使用（不自开事务）', () => {
    const test = harness()
    const idem = test.ctx.get(SAGA_IDEMPOTENCY)
    const key = makeKey('FWD', SAGA, STEP, makeNonce())

    const outcome = test.store.tx((tx) => {
      const first = idem.reserveIn(tx, key, record(key, 'req-1'), 60_000)
      idem.completeIn(tx, key, 'resp-1', 'fp')
      return first
    })
    expect(outcome).toEqual({ ok: true })
    expect(test.idemRow(key)?.status).toBe('DONE')
  })
})
