/**
 * `safety:sandbox` 宿主行：配置校验、服务接线、worker 求值与审计。
 */

import { createContext } from '@bah/core'
import { BANK_COMPUTE } from '@bah/bank'
import { SESSION_SERVICE, provideSession } from '@bah/runtime'
import { asSessionId, captureThrown, fixedClock } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { RUN_SERVICE } from '../boot.ts'
import {
  DEFAULT_SANDBOX_SETTINGS,
  asComputeResult,
  sandboxPlugin,
  unwrapOutcome,
} from './sandbox.ts'

describe('safety:sandbox 配置', () => {
  it('缺省值来自档位规格；非法值 fail-loud', () => {
    expect(sandboxPlugin.validate({})).toEqual(DEFAULT_SANDBOX_SETTINGS)
    expect(() => sandboxPlugin.validate({ timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => sandboxPlugin.validate({ extra: 1 })).toThrow(/未知配置键/)
  })
})

describe('safety:sandbox 接线', () => {
  it('提供 BANK_COMPUTE：经 worker 求值并落 sandbox 审计事件', async () => {
    const ctx = createContext()
    const sessionId = asSessionId('s-sandbox')
    ctx.provide(RUN_SERVICE, { sessionId, now: () => 0 })
    provideSession(ctx, { sessionId, now: () => 0 })
    await ctx.use(
      sandboxPlugin.plugin,
      sandboxPlugin.validate({ timeoutMs: 2_000, maxOperations: 10_000, maxConcurrency: 1 }),
    )
    await ctx.start()
    try {
      const compute = ctx.get(BANK_COMPUTE)
      const result = await compute({
        code: '1 + 2 * 3',
        limits: { timeoutMs: 1_000, maxOperations: 100 },
      })
      expect(result.value).toBe(7)
      expect(result.operations).toBeGreaterThan(0)

      const events = ctx.get(SESSION_SERVICE).events()
      expect(events.some((event) => String(event.type) === 'sandbox/done')).toBe(true)
    } finally {
      await ctx.dispose('test')
    }
  })

  it('沙箱审计钟可独立注入：elapsedMs 等于注入钟的步长（不读墙钟）', async () => {
    // 步长取 4096：无注入时真实墙钟耗时不可能恰好等于它，负控不会被巧合掩盖。
    const sandboxClock = fixedClock({ start: 1_000, step: 4_096 })
    const ctx = createContext()
    const sessionId = asSessionId('s-sandbox-clock')
    ctx.provide(RUN_SERVICE, { sessionId, now: () => 0, sandboxNow: sandboxClock.tick })
    provideSession(ctx, { sessionId, now: () => 0 })
    await ctx.use(
      sandboxPlugin.plugin,
      sandboxPlugin.validate({ timeoutMs: 2_000, maxOperations: 10_000, maxConcurrency: 1 }),
    )
    await ctx.start()
    try {
      const compute = ctx.get(BANK_COMPUTE)
      const result = await compute({
        code: '1 + 2 * 3',
        limits: { timeoutMs: 1_000, maxOperations: 100 },
      })
      expect(result.value).toBe(7)

      const done = ctx
        .get(SESSION_SERVICE)
        .events()
        .find((event) => String(event.type) === 'sandbox/done')
      expect(done).toBeDefined()
      expect((done?.data as { elapsedMs?: number }).elapsedMs).toBe(4_096)
    } finally {
      await ctx.dispose('test')
    }
  })
})

describe('沙箱结局映射', () => {
  it('ok → ComputeResult；非法值 → sandbox-result-invalid', () => {
    expect(
      unwrapOutcome({ kind: 'ok', value: { value: 7, operations: 3 }, tier: 'compute-bounded', elapsedMs: 1 }),
    ).toEqual({ value: 7, operations: 3 })
    expect(captureThrown(() => asComputeResult(null)).code).toBe('sandbox-result-invalid')
    expect(captureThrown(() => asComputeResult({ value: 'x', operations: 1 })).code).toBe(
      'sandbox-result-invalid',
    )
    expect(captureThrown(() => asComputeResult({ value: 1, operations: -1 })).code).toBe(
      'sandbox-result-invalid',
    )
  })

  it('refused / error（程序码映射）/ timeout 都抛结构化错误', () => {
    expect(
      captureThrown(() =>
        unwrapOutcome({ kind: 'refused', code: 'sandbox-payload-too-large', reason: 'too big' }),
      ).code,
    ).toBe('sandbox-payload-too-large')
    expect(
      captureThrown(() =>
        unwrapOutcome({ kind: 'error', code: 'program-invalid', message: 'bad', tier: 'compute-bounded' }),
      ).code,
    ).toBe('compute-invalid')
    expect(
      captureThrown(() => unwrapOutcome({ kind: 'timeout', tier: 'compute-bounded', timeoutMs: 5 })).code,
    ).toBe('sandbox-timeout')
  })
})
