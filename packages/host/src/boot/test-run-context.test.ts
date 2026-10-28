/**
 * `testRunContext` 的口径用例（租户与鉴权 01 · TA-11）。
 *
 * 这条夹具被 20+ 个用例与 7 个快照场景共用：它一旦悄悄改缺省值，
 * "所有测试都在 demo 租户下跑"这个前提就没了。所以缺省值本身要有断言。
 */

import { describe, expect, it } from 'vitest'

import { parseTenantId } from '@bah/util'
import { asSessionId } from '@bah/test-support'

import { testRunContext } from './test-run-context.ts'

describe('testRunContext', () => {
  it('TA-11-4 缺省：会话 s-test、租户 demo、固定钟（两次调用同一时刻）', () => {
    const first = testRunContext()
    const second = testRunContext()
    expect(String(first.sessionId)).toBe('s-test')
    expect(String(first.tenantId)).toBe('demo')
    expect(first.now()).toBe(second.now())
  })

  it('TA-11-5 覆盖生效：会话 / 租户 / 时钟互不串', () => {
    const run = testRunContext({
      sessionId: asSessionId('s-boot'),
      tenantId: parseTenantId('acme'),
      now: () => 42,
    })
    expect(String(run.sessionId)).toBe('s-boot')
    expect(String(run.tenantId)).toBe('acme')
    expect(run.now()).toBe(42)
  })

  it('TA-11-6 可选字段：不传就不出现在对象上（不给下游一个"看起来配了"的 undefined）', () => {
    const bare = testRunContext()
    expect('jsonlDir' in bare).toBe(false)
    expect('probe' in bare).toBe(false)
    expect('warn' in bare).toBe(false)
    const full = testRunContext({ probe: false, jsonlDir: 'tmp-x' })
    expect(full.probe).toBe(false)
    expect(full.jsonlDir).toBe('tmp-x')
  })
})
