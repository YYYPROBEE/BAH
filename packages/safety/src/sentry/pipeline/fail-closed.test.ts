/**
 * fail-closed 包装（施工单 HP-0 §5 的 HP0-01 / 02 / 03 / 04）。
 *
 * 这一组用例的价值在于**证明降级方向**：判决件坏掉时必须更严，而不是更松。
 * 任何一条退回"异常 → accept"，都能让 `pnpm test` 立刻红。
 */

import { createContext } from '@bah/core'
import type { Context, SessionId } from '@bah/core'
import { describe, expect, it } from 'vitest'

import { TraceLog } from '../kernel/index.ts'

import {
  createSentryPostExecuteListener,
  failClosedPostExecute,
  provideSentry,
  resolveSentrySettings,
  SentryState,
  VERIFIER_UNAVAILABLE,
  type PostExecuteListener,
} from './index.ts'

/** 一条 post-execute 载荷（形状与七段管线一致）。 */
const PAYLOAD = {
  call: { callId: 'call-1', name: 'transfer_create', args: { amount: 800 } },
  content: [{ type: 'text', text: '转账成功，金额 800.00 元' }],
  verdict: { kind: 'accept' as const },
}

interface Harness {
  readonly trace: TraceLog
  readonly recorded: { type: string; data: Record<string, unknown> }[]
  readonly listener: PostExecuteListener
}

/** 造一个包装过的监听器（内层行为由用例给）。 */
function harness(inner: PostExecuteListener): Harness {
  const trace = new TraceLog({ now: () => 1_000 })
  const recorded: { type: string; data: Record<string, unknown> }[] = []
  let now = 1_000
  const listener = failClosedPostExecute(inner, {
    sessionId: 's-fail-closed',
    trace,
    record: (type, data) => recorded.push({ type, data: data as Record<string, unknown> }),
    now: () => {
      now += 1
      return now
    },
  })
  return { trace, recorded, listener }
}

/** 下游 `next`：原样返回，并记录被调用次数。 */
function downstream(): { next: (value: unknown) => Promise<unknown>; calls: () => number } {
  let calls = 0
  return {
    next: (value) => {
      calls += 1
      return Promise.resolve(value)
    },
    calls: () => calls,
  }
}

describe('fail-closed：判决件异常 → block（HP0-01）', () => {
  it('内层抛错时返回 block + code=verifier-unavailable', async () => {
    const test = harness(() => Promise.reject(new Error('对账组件崩了')))
    const { next } = downstream()

    const result = (await test.listener(PAYLOAD, next)) as {
      call: unknown
      verdict: { kind: string; code: string; reason: string }
    }

    expect(result.verdict.kind).toBe('block')
    expect(result.verdict.code).toBe(VERIFIER_UNAVAILABLE)
    // 原载荷必须保留：block 只改判决，不丢 call / content（下游还要落审计）
    expect(result.call).toEqual(PAYLOAD.call)
  })

  it('异常发生在 next 之后：仍以 block 覆盖下游判决（fail-closed 优先）', async () => {
    const test = harness(async (payload, next) => {
      const downstreamResult = (await next(payload)) as { verdict: { kind: string } }
      expect(downstreamResult.verdict.kind).toBe('accept')
      throw new Error('对账读到一半炸了')
    })
    const { next } = downstream()

    const result = (await test.listener(PAYLOAD, next)) as { verdict: { kind: string; code: string } }

    expect(result.verdict.kind).toBe('block')
    expect(result.verdict.code).toBe(VERIFIER_UNAVAILABLE)
  })

  it('next 最多被调用一次（内层重复调用不放大下游副作用）', async () => {
    const test = harness(async (payload, next) => {
      await next(payload)
      await next(payload)
      return next(payload)
    })
    const spy = downstream()

    await test.listener(PAYLOAD, spy.next)

    expect(spy.calls()).toBe(1)
  })
})

describe('fail-closed：正常路径不改变判决（HP0-02）', () => {
  it('内层原样返回时，包装器逐字段透传', async () => {
    const inner: PostExecuteListener = async (payload, next) => next(payload)
    const test = harness(inner)
    const { next } = downstream()

    const result = await test.listener(PAYLOAD, next)

    expect(result).toEqual(PAYLOAD)
    expect(test.recorded).toEqual([])
    expect(test.trace.recent(10)).toEqual([])
  })

  it('内层返回自定义判决时不被包装器改写', async () => {
    const inner: PostExecuteListener = () =>
      Promise.resolve({
        ...PAYLOAD,
        verdict: { kind: 'block', code: 'honesty-number-mismatch', reason: '金额不一致' },
      })
    const test = harness(inner)
    const { next } = downstream()

    const result = (await test.listener(PAYLOAD, next)) as {
      verdict: { kind: string; code: string }
    }

    expect(result.verdict).toEqual({ kind: 'block', code: 'honesty-number-mismatch', reason: '金额不一致' })
  })
})

describe('fail-closed：落账与去敏（HP0-03）', () => {
  it('抛错时落 sentry/verifier-failed + TraceLog', async () => {
    const test = harness(() => Promise.reject(new Error('boom')))
    const { next } = downstream()

    await test.listener(PAYLOAD, next)

    expect(test.recorded).toHaveLength(1)
    expect(test.recorded[0]?.type).toBe('sentry/verifier-failed')
    expect(test.recorded[0]?.data).toMatchObject({
      listener: 'tools/post-execute',
      code: VERIFIER_UNAVAILABLE,
      message: 'boom',
    })

    const trace = test.trace.recent(10)
    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatchObject({ session: 's-fail-closed', kind: 'honesty-verifier-failed' })
  })

  it('错误消息截断到 200 字，且不拼接工具参数与结果', async () => {
    const long = `E${'x'.repeat(500)}`
    const test = harness(() => Promise.reject(new Error(long)))
    const { next } = downstream()

    await test.listener(PAYLOAD, next)

    const message = String(test.recorded[0]?.data['message'] ?? '')
    // 200 个码点 + 省略号
    expect([...message]).toHaveLength(201)
    expect(message.startsWith('Ex')).toBe(true)

    // 去敏：审计里不得出现工具参数里的金额与收款人
    const serialized = JSON.stringify(test.recorded)
    expect(serialized).not.toContain('800')
    expect(serialized).not.toContain('王建国')
  })

  it('非 Error 的抛出值也能落账（String 化，不炸第二次）', async () => {
    const test = harness(() => Promise.reject('plain-string'))
    const { next } = downstream()

    const result = (await test.listener(PAYLOAD, next)) as { verdict: { kind: string } }

    expect(result.verdict.kind).toBe('block')
    expect(test.recorded[0]?.data['message']).toBe('plain-string')
  })
})

describe('fail-closed：sentry 集成（HP0-04）', () => {
  it('downstream 监听器抛错 → sentry 包装器把它转成 block，结果不进模型可信内容', async () => {
    const ctx: Context = createContext()
    const recorded: { type: string; data: Record<string, unknown> }[] = []
    provideSentry(ctx, resolveSentrySettings({}), {
      sessionId: 's-integration' as SessionId,
      now: () => 1_000,
      record: (type, data) => recorded.push({ type, data: data as Record<string, unknown> }),
      toolTier: () => undefined,
      ticketStatus: () => undefined,
      revokeTickets: () => 0,
      nudge: () => undefined,
    })

    // 后注册 = 更内层：它的异常必须被 sentry 的包装器接住
    ctx.effect(
      ctx.events.on('tools/post-execute', () => {
        throw new Error('下游判决件崩了')
      }),
    )

    const result = (await ctx.events.waterfall('tools/post-execute', PAYLOAD)) as {
      content: { text: string }[]
      verdict: { kind: string; code: string; reason: string }
    }

    expect(result.verdict.kind).toBe('block')
    expect(result.verdict.code).toBe(VERIFIER_UNAVAILABLE)
    // 模型看到的是固定话术，不是原始工具结果。**content 的替换发生在七段管线的
    // block 分支**（`pipeline.ts` 用 `verdict.reason` 覆盖 content），waterfall 只负责给判决；
    // 所以这里断言的是 reason，不是 content。
    expect(result.verdict.reason).toContain('结果核验组件异常')
    expect(result.verdict.reason).not.toContain('转账成功')

    const failed = recorded.filter((item) => item.type === 'sentry/verifier-failed')
    expect(failed).toHaveLength(1)

    await ctx.dispose('test-done')
  })

  it('createSentryPostExecuteListener 就是"数值对账 + fail-closed"的组合', async () => {
    const trace = new TraceLog({ now: () => 1_000 })
    const listener = createSentryPostExecuteListener({
      sessionId: 's-compose',
      settings: resolveSentrySettings({}),
      state: new SentryState(),
      trace,
      record: () => undefined,
      now: () => 1_000,
      nudge: () => undefined,
    })
    const next = (_value: unknown): Promise<unknown> => Promise.reject(new Error('内层坏了'))

    const result = (await listener(PAYLOAD, next)) as { verdict: { kind: string; code: string } }

    expect(result.verdict.kind).toBe('block')
    expect(result.verdict.code).toBe(VERIFIER_UNAVAILABLE)
  })
})
