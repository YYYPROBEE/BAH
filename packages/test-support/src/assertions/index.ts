/**
 * 结构化错误断言助手（施工单 00 §9 第 5 条「错误必须结构化」的测试侧落地）。
 *
 * 用例里不要写 `expect(() => fn()).toThrow()` 就完事——那只验证「抛了」，
 * 不验证 `code` 与 `bah-<pkg>: ` 前缀。这里把「抓错 + 验形状」收敛成一处。
 */

import { BahError } from '@bah/util'

/** 把任意抛出物渲染成可读文本（非 Error 也要能看）。 */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * 抓同步抛出的 `BahError`。
 *
 * @param run 期望抛错的同步动作
 * @throws 没抛、或抛出的不是 `BahError` 时，直接以可读理由失败
 */
export function captureThrown(run: () => unknown): BahError {
  try {
    run()
  } catch (error) {
    if (error instanceof BahError) return error
    throw new Error(`test-support: 期望抛出 BahError，实际抛出 ${describe(error)}`)
  }
  throw new Error('test-support: 期望抛出 BahError，但没有抛')
}

/**
 * 抓异步拒绝（`Promise` reject）里的 `BahError`。
 *
 * @param run 期望 reject 的异步动作
 * @throws 没 reject、或 reject 的不是 `BahError` 时，直接以可读理由失败
 */
export async function captureRejection(run: () => Promise<unknown>): Promise<BahError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof BahError) return error
    throw new Error(`test-support: 期望 reject BahError，实际 reject ${describe(error)}`)
  }
  throw new Error('test-support: 期望 reject BahError，但没有 reject')
}
