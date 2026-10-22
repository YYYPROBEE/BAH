/**
 * `commitSegment` 的失败映射与提交顺序（SA-08 §3.3）。
 *
 * 这段代码只做两件事，但两件都是"错了没人发现"的类型：
 * 1. 审计缓冲必须在 COMMIT **之前** flush（顺序反了就是"账已落、链没落"）；
 * 2. 段内异常必须统一归一为 `commit-failed`，但**已经是** `commit-failed` 的
 *    不能再包一层——否则重试逻辑按 code 判定会失配。
 */

import { describe, expect, it } from 'vitest'

import { SAGA_AUDIT, SAGA_STORE } from '../seams.ts'
import { commitSegment } from './commit.ts'

import type { Context } from '@bah/core'
import type { SagaTx } from '../seams.ts'

interface Harness {
  readonly ctx: Context
  readonly order: string[]
  /** 让 store 的 tx 抛出该异常；`undefined` 表示成功。 */
  setFailure(error: unknown): void
  setDeferred(enabled: boolean): void
}

function harness(): Harness {
  const order: string[] = []
  let failure: unknown
  let hasFailure = false
  let deferredEnabled = true

  const audit = {
    get beginDeferred() {
      return deferredEnabled
        ? () => ({
            flush: () => order.push('flush'),
            discard: () => order.push('discard'),
          })
        : undefined
    },
  }

  const store = {
    tx<T>(fn: (tx: SagaTx) => T, hooks?: { beforeCommit?: () => void }): T {
      if (hasFailure) throw failure
      hooks?.beforeCommit?.()
      order.push('commit')
      return fn({} as SagaTx)
    },
  }

  const ctx = {
    get: (key: unknown) => (key === SAGA_STORE ? store : audit),
  } as unknown as Context

  return {
    ctx,
    order,
    setFailure(error: unknown) {
      failure = error
      hasFailure = true
    },
    setDeferred(enabled: boolean) {
      deferredEnabled = enabled
    },
  }
}

describe('commitSegment · 提交顺序', () => {
  it('审计缓冲先 flush，再 COMMIT，最后才是业务 fn 的副作用', () => {
    const h = harness()
    commitSegment(h.ctx, () => {
      h.order.push('fn')
      return 'ok'
    })
    expect(h.order).toEqual(['flush', 'commit', 'fn'])
  })

  it('审计不支持 beginDeferred 时退化为直接提交（不调用任何缓冲）', () => {
    const h = harness()
    h.setDeferred(false)
    expect(commitSegment(h.ctx, () => 'ok')).toBe('ok')
    expect(h.order).toEqual(['commit'])
    expect(h.order).not.toContain('discard')
  })
})

describe('commitSegment · 失败映射', () => {
  it('已是 commit-failed 的异常原样透传（不重复包装）', () => {
    const h = harness()
    // 用带 code 的普通对象：验证判定只看 code，不看 instanceof。
    const original = Object.assign(new Error('已经归一过'), { code: 'commit-failed' })
    h.setFailure(original)

    let caught: unknown
    try {
      commitSegment(h.ctx, () => 'never')
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(original)
    // 失败路径必须丢弃缓冲，不能把半截审计落进链里。
    expect(h.order).toContain('discard')
    expect(h.order).not.toContain('flush')
  })

  it('普通 Error 包成 commit-failed 并保留 cause 与原文', () => {
    const h = harness()
    const cause = new Error('磁盘只读')
    h.setFailure(cause)

    expect(() => commitSegment(h.ctx, () => 'never')).toThrowError(/磁盘只读/)
    try {
      commitSegment(h.ctx, () => 'never')
    } catch (error) {
      // BahError 的第三参是结构化 `detail`（不是原生 `cause`），原文挂在这里。
      const failure = error as { code?: string; detail?: { cause?: unknown } }
      expect(failure.code).toBe('commit-failed')
      expect(failure.detail?.cause).toBe(cause)
    }
  })

  it('非 Error 抛出物也能归一（字符串化而不是 [object Object] 崩掉）', () => {
    const h = harness()
    h.setFailure('下游直接抛了字符串')

    let caught: unknown
    try {
      commitSegment(h.ctx, () => 'never')
    } catch (error) {
      caught = error
    }
    const failure = caught as { code?: string; message?: string }
    expect(failure.code).toBe('commit-failed')
    expect(failure.message).toContain('下游直接抛了字符串')
  })
})
