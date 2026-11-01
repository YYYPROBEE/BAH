/**
 * 审计链句柄的两条完整性守卫。
 *
 * 1. `beginDeferred` 嵌套：同一链只允许一个未结束的延迟写批次。嵌套若被放行，
 *    两批行的写入顺序会交错，`recordHash` 的前驱关系随之断裂——链"看起来有行"，
 *    但连续性校验永远过不去；
 * 2. 判决信封形状：`decision` 不是字符串时必须在入链前拒绝，否则一条无法规范化
 *    哈希的判决会成为链上的永久空洞。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { createSagaAudit } from './index.ts'

/** 取 `beginDeferred`（类型上是可选方法，句柄实现里始终存在）。 */
function beginOf(handle: ReturnType<typeof createSagaAudit>) {
  const begin = handle.beginDeferred
  if (begin === undefined) throw new Error('链句柄没有 beginDeferred')
  return begin
}

describe('createSagaAudit：延迟批次与信封形状', () => {
  it('同一链第二次 beginDeferred ⇒ audit-deferred-nested；discard 后可重新开始', () => {
    const handle = createSagaAudit({ now: () => 1 })
    const begin = beginOf(handle)
    const batch = begin()
    expect(captureThrown(() => begin()).code).toBe('audit-deferred-nested')

    // 丢弃 = 状态归零：不归零的话这条链会被永久卡在"已有未结束批次"
    batch.discard()
    begin().flush()
  })

  it('decision 不是字符串 ⇒ chain-envelope-invalid（不写一条无法哈希的判决）', () => {
    const handle = createSagaAudit({ now: () => 1 })
    expect(
      captureThrown(() =>
        handle.append('s-1', 'sentry/decision', {}, undefined, {
          subject: 'call-1',
          decision: 42,
          policyVersion: 'v1',
        } as never),
      ).code,
    ).toBe('chain-envelope-invalid')
  })
})
