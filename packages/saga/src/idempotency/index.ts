/**
 * 幂等信封（SA-09 §3.2 / O1 / O13）。
 *
 * 三种结局：① 主键插入成功；② 租约过期 → 接管；③ 持有中 → `lease-held`；
 * 同键异载 → `key-conflict`（防预测占位，A2 变体）。
 *
 * 事务纪律：`reserve`/`complete` 带自身事务（**仅限没有外层事务时**）；
 * 已在 `store.tx` 内（如 SA-08 `commitSegment`）必须用 `reserveIn`/`completeIn`，
 * 否则嵌套 `BEGIN IMMEDIATE` 会直接报错。
 */

import { BahError } from '@bah/util'

import { SAGA_CLOCK, SAGA_IDEMPOTENCY, SAGA_STORE } from '../seams.ts'

import { makeKey } from './key.ts'

import type { Context } from '@bah/core'

import type { SagaIdempotency, SagaStore, SagaTx } from '../seams.ts'
import type { IdempotencyRecord } from '../types.ts'

export { makeKey, makeNonce, seed } from './key.ts'

/** 三种结局的实现体：不自开事务。 */
export function reserveInTx(
  tx: SagaTx,
  key: string,
  input: IdempotencyRecord,
  ttlMs: number,
  now: number,
): { ok: true } | { ok: false; reason: 'lease-held' | 'key-conflict' } {
  const leaseExpiry = now + ttlMs
  const owner = input.leaseOwner ?? ''

  // 结局一：原子占位（PRIMARY KEY 冲突检测，单语句）。
  if (tx.insertIdempotency({ ...input, idemKey: key, status: 'RESERVED', leaseExpiry })) {
    return { ok: true }
  }

  const existing = tx.readIdempotency(key)
  if (existing === undefined) {
    throw new BahError('unreachable-branch', 'bah-saga: idempotency-vanish: 冲突后读不到行', { key })
  }

  // 同键异载 → 拒绝（不推进、不覆盖）。
  if (existing.requestDigest !== input.requestDigest) {
    return { ok: false, reason: 'key-conflict' }
  }

  // 结局二：租约过期 → 新 worker 接管。
  if (existing.leaseExpiry !== undefined && existing.leaseExpiry <= now) {
    if (tx.takeoverIdempotency(key, owner, leaseExpiry)) return { ok: true }
  }

  // 结局三：持有中（等待 / 换 worker，不硬抢）。
  return { ok: false, reason: 'lease-held' }
}

/** 装配幂等服务；store/clock 在使用时按服务键读取（允许先于存储插件 apply）。 */
export function installIdempotency(ctx: Context): void {
  const store = (): SagaStore => ctx.get(SAGA_STORE)

  const impl: SagaIdempotency = {
    makeKey,

    reserve(key, input, ttlMs) {
      const now = ctx.get(SAGA_CLOCK).now()
      return store().tx((tx) => reserveInTx(tx, key, input, ttlMs, now))
    },

    complete(key, responseDigest, fingerprint) {
      store().tx((tx) => impl.completeIn(tx, key, responseDigest, fingerprint))
    },

    reserveIn(tx, key, input, ttlMs) {
      return reserveInTx(tx, key, input, ttlMs, ctx.get(SAGA_CLOCK).now())
    },

    completeIn(tx, key, responseDigest, fingerprint) {
      if (tx.readIdempotency(key) === undefined) {
        throw new BahError('idempotency-missing', `bah-saga: idempotency-missing: ${key}`, { key })
      }
      tx.completeIdempotency(key, responseDigest, fingerprint)
    },
  }

  ctx.provide(SAGA_IDEMPOTENCY, impl)
}
