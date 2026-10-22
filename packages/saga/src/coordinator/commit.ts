/**
 * 单提交段（SA-08 §3.3 / SA-00 §6）。
 *
 * 顺序不可反：业务窄表写入（sqlite 事务内）→ 审计 append + fsync → COMMIT。
 * `SAGA_AUDIT` 若支持 `beginDeferred()`（JSONL 链实现），事务内的 append 只进缓冲；
 * 本函数通过 store 的 `beforeCommit` 内钩子在 COMMIT **之前**统一落盘。
 * `fn` 抛错 → 缓冲丢弃 + sqlite ROLLBACK（三者无部分生效）。
 */

import { BahError } from '@bah/util'

import { SAGA_AUDIT, SAGA_STORE } from '../seams.ts'

import type { Context } from '@bah/core'

import type { SagaTx } from '../seams.ts'

/**
 * 在单个提交段内执行 `fn`。
 *
 * @throws `BahError('commit-failed')` 段内任一步失败（含审计 fsync）
 */
export function commitSegment<T>(ctx: Context, fn: (tx: SagaTx) => T): T {
  const store = ctx.get(SAGA_STORE)
  const audit = ctx.get(SAGA_AUDIT)
  const deferred = audit.beginDeferred?.()

  try {
    return store.tx(fn, {
      beforeCommit: () => deferred?.flush(),
    })
  } catch (error) {
    deferred?.discard()
    if ((error as { code?: string }).code === 'commit-failed') throw error
    throw new BahError(
      'commit-failed',
      `bah-saga: commit-failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
