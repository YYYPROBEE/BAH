/**
 * `obs:telemetry` 的三件事：配置校验、装配、按需派生。
 *
 * 最值得测的一条是**时钟可信度由数据判定**：全仓没有 `Clock.tick()`，快照回放里
 * `fixedClock.now()` 幂等 ⇒ 同一场景所有事件 `at` 相同。如果这里判错，
 * 瀑布图会把"没测过"画成"很快"，而那正是本方案明令禁止的三种"零"之一。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import { SESSION_SERVICE, type SessionApi } from '@bah/runtime'
import { afterEach, describe, expect, it } from 'vitest'

import { RUN_SERVICE } from '../boot.ts'
import { MODEL_PRICING } from './model.ts'
import { TELEMETRY, telemetryPlugin } from './telemetry.ts'

const T = 1_700_000_000_000

/** 环境变量覆盖是进程级的；每条用例后恢复，避免互相污染。 */
const savedEnv = new Map<string, string | undefined>()
function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

/** 一个只够 `derive()` 用的会话桩（`events()` 是唯一被读的方法）。 */
function fakeSession(events: readonly { seq: number; at: number; type: string; data: unknown }[]): SessionApi {
  return {
    sessionId: 's-telemetry',
    formatVersion: 1,
    lastSeq: () => events.length,
    events: () => events,
    eventsView: () => events,
  } as unknown as SessionApi
}

/** 起一个只装了 `obs:telemetry` 的上下文。 */
async function boot(options: {
  events?: readonly { seq: number; at: number; type: string; data: unknown }[]
  config?: Readonly<Record<string, unknown>>
  jsonlDir?: string
} = {}) {
  const ctx = createContext()
  ctx.provide(RUN_SERVICE, {
    sessionId: 's-telemetry' as never,
    now: () => T,
    ...(options.jsonlDir === undefined ? {} : { jsonlDir: options.jsonlDir }),
  })
  ctx.provide(SESSION_SERVICE, fakeSession(options.events ?? []))
  await ctx.use(telemetryPlugin.plugin, telemetryPlugin.validate(options.config ?? {}))
  await ctx.start()
  return ctx
}

describe('obs:telemetry · 配置校验', () => {
  it('缺省：容量 2000、只留内存、无采样覆盖、预算全关、无 webhook', () => {
    expect(telemetryPlugin.validate({})).toEqual({
      maxSpans: 2000,
      spanLog: null,
      sample: {},
      guard: { maxTurnCostMicroYuan: 0, maxSessionCostMicroYuan: 0, maxTurnOutputTokens: 0 },
      alerts: { webhook: null },
    })
  })

  it('未知键 fail-loud（静默取缺省会导致"配了却没生效"）', () => {
    expect(() => telemetryPlugin.validate({ maxSpan: 10 })).toThrow(/maxSpan/)
  })

  it('maxSpans 越界 fail-loud', () => {
    expect(() => telemetryPlugin.validate({ maxSpans: 10 })).toThrow(/100/)
    expect(() => telemetryPlugin.validate({ maxSpans: 1_000_000 })).toThrow(/100000/)
  })

  it('sample 必须是 [0,1] 的数', () => {
    expect(() => telemetryPlugin.validate({ sample: { 'policy.evaluate': 2 } })).toThrow(/0,1/)
    expect(() => telemetryPlugin.validate({ sample: 'x' })).toThrow(/sample/)
    expect(telemetryPlugin.validate({ sample: { 'policy.evaluate': 0.1 } })).toMatchObject({
      sample: { 'policy.evaluate': 0.1 },
    })
  })

  it('BAH_TELEMETRY_MAX_SPANS 覆盖 config（合法正整数）', () => {
    setEnv('BAH_TELEMETRY_MAX_SPANS', '5000')
    expect(telemetryPlugin.validate({ maxSpans: 300 }).maxSpans).toBe(5000)
  })

  it('BAH_TELEMETRY_MAX_SPANS 非法时忽略并回落 config', () => {
    setEnv('BAH_TELEMETRY_MAX_SPANS', 'abc')
    for (const bad of ['abc', '0', '-1', '1.5']) {
      process.env['BAH_TELEMETRY_MAX_SPANS'] = bad
      expect(telemetryPlugin.validate({ maxSpans: 300 }).maxSpans).toBe(300)
    }
  })

  it('BAH_SPAN_LOG 覆盖 config', () => {
    setEnv('BAH_SPAN_LOG', 'logs/spans.jsonl')
    expect(telemetryPlugin.validate({ spanLog: 'config.jsonl' }).spanLog).toBe('logs/spans.jsonl')
  })

  it('guard 三键：缺省 0，负数/小数 fail-loud', () => {
    expect(telemetryPlugin.validate({ guard: { maxTurnOutputTokens: 100 } }).guard).toEqual({
      maxTurnCostMicroYuan: 0,
      maxSessionCostMicroYuan: 0,
      maxTurnOutputTokens: 100,
    })
    expect(() => telemetryPlugin.validate({ guard: { maxTurnCostMicroYuan: -1 } })).toThrow(/非负整数/)
    expect(() => telemetryPlugin.validate({ guard: { maxTurnCostMicroYuan: 1.5 } })).toThrow(/非负整数/)
  })

  it('alerts.webhook 必须是 http(s)；BAH_ALERT_WEBHOOK 覆盖 config', () => {
    expect(telemetryPlugin.validate({ alerts: { webhook: 'https://example.test/hook' } }).alerts).toEqual({
      webhook: 'https://example.test/hook',
    })
    expect(() => telemetryPlugin.validate({ alerts: { webhook: 'file:///etc/passwd' } })).toThrow(/http/)
    setEnv('BAH_ALERT_WEBHOOK', 'https://env.test/hook')
    expect(telemetryPlugin.validate({ alerts: { webhook: 'https://config.test/hook' } }).alerts).toEqual({
      webhook: 'https://env.test/hook',
    })
  })
})

describe('obs:telemetry · 装配与派生', () => {
  it('提供 obs:telemetry 服务键，且不产生任何会话事件', async () => {
    const ctx = await boot()
    try {
      const handle = ctx.get(TELEMETRY)
      expect(handle).toBeDefined()
      expect(handle.stats.size).toBe(0)
      expect(handle.spanLogPath).toBeNull()
      expect(handle.budgetExhausted()).toEqual({ turn: 0, session: 0 })
      await expect(handle.withSpanAsync('rag.answer', {}, async () => 'ok')).resolves.toBe('ok')
    } finally {
      await ctx.dispose('test')
    }
  })

  it('真钟（at 有多个值）→ clockTrusted = true', async () => {
    const ctx = await boot({
      events: [
        { seq: 1, at: T, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, at: T + 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    })
    try {
      const snapshot = ctx.get(TELEMETRY).derive()
      expect(snapshot.clockTrusted).toBe(true)
      expect(snapshot.spans).toHaveLength(1)
      expect(snapshot.spans[0]!.endMs).not.toBe(snapshot.spans[0]!.startMs)
      expect(snapshot.roots).toHaveLength(1)
    } finally {
      await ctx.dispose('test')
    }
  })

  it('冻结钟（所有 at 相同）→ clockTrusted = false，并标 clock=frozen', async () => {
    const ctx = await boot({
      events: [
        { seq: 1, at: T, type: 'turn/start', data: { turn: 1 } },
        { seq: 2, at: T, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    })
    try {
      const snapshot = ctx.get(TELEMETRY).derive()
      expect(snapshot.clockTrusted).toBe(false)
      expect(snapshot.spans[0]!.attributes['clock']).toBe('frozen')
    } finally {
      await ctx.dispose('test')
    }
  })

  it('costConfigured 跟随 core:model.pricing（没装 model 时为 false）', async () => {
    const ctx = await boot()
    try {
      expect(ctx.get(TELEMETRY).costConfigured()).toBe(false)
      ctx.provide(MODEL_PRICING, { configured: true })
      expect(ctx.get(TELEMETRY).costConfigured()).toBe(true)
    } finally {
      await ctx.dispose('test')
    }
  })

  it('alerts.webhook 非空时注册出口（不影响装配）', async () => {
    const ctx = await boot({ config: { alerts: { webhook: 'https://example.test/hook' } } })
    try {
      expect(ctx.get(TELEMETRY).spanLogPath).toBeNull()
    } finally {
      await ctx.dispose('test')
    }
  })

  it('spanLog 目录建不出来 → fail-open（装配不失败）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bah-telemetry-bad-'))
    const blocking = join(base, 'not-a-dir')
    writeFileSync(blocking, 'x')
    const ctx = await boot({ config: { spanLog: join(blocking, 'span.jsonl') } })
    try {
      expect(ctx.get(TELEMETRY).spanLogPath).toBe(join(blocking, 'span.jsonl'))
    } finally {
      await ctx.dispose('test')
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('derive() 把结果并进记录器，重复调用不重复计数（absorb 去重）', async () => {
    const ctx = await boot({
      events: [{ seq: 1, at: T, type: 'turn/start', data: { turn: 1 } }],
    })
    try {
      const handle = ctx.get(TELEMETRY)
      handle.derive()
      handle.derive()
      expect(handle.stats.size).toBe(1)
    } finally {
      await ctx.dispose('test')
    }
  })
})

describe('obs:telemetry · 预算闸', () => {
  const summary = (turn: number, costMicroYuan: number): { seq: number; at: number; type: string; data: unknown } => ({
    seq: 1,
    at: T,
    type: 'usage/summary',
    data: { turn, input: 10, output: 10, cachedInput: 0, costMicroYuan },
  })

  it('本轮成本超限 → pre-step reject（信封，不是裸 verdict）', async () => {
    const ctx = await boot({
      events: [summary(1, 1500)],
      config: { guard: { maxTurnCostMicroYuan: 1000 } },
    })
    try {
      const input = {
        agent: {} as never,
        messages: [],
        // usage/summary 属于上一轮（turn 1）；下一轮第一步才拿到它并拒
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
        verdict: { kind: 'enter' as const, messages: [] },
      }
      const result = (await ctx.events.waterfall('agent/pre-step', input)) as {
        verdict: { kind: string; code?: string; reason?: string }
      }
      expect(result.verdict.kind).toBe('reject')
      expect(result.verdict.code).toBe('usage-budget-exhausted')
      expect(result.verdict.reason).toMatch(/1500\/1000/)
    } finally {
      await ctx.dispose('test')
    }
  })

  it('会话成本超限 → turn-stopping 判停，reason 含数字', async () => {
    const ctx = await boot({
      events: [summary(1, 2000)],
      config: { guard: { maxSessionCostMicroYuan: 1000 } },
    })
    try {
      let stopped: string | undefined
      await ctx.events.serial('agent/turn-stopping', {
        agent: {} as never,
        turn: 1,
        signal: new AbortController().signal,
        stop: (reason?: string) => {
          stopped = reason
        },
      })
      expect(stopped).toMatch(/2000\/1000/)
    } finally {
      await ctx.dispose('test')
    }
  })

  it('上一轮输出 token 超限 → pre-step reject', async () => {
    const ctx = await boot({
      events: [{ seq: 1, at: T, type: 'usage/summary', data: { turn: 1, input: 10, output: 100, cachedInput: 0, costMicroYuan: 0 } }],
      config: { guard: { maxTurnOutputTokens: 50 } },
    })
    try {
      const input = {
        agent: {} as never,
        messages: [],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
        verdict: { kind: 'enter' as const, messages: [] },
      }
      const result = (await ctx.events.waterfall('agent/pre-step', input)) as {
        verdict: { kind: string; code?: string }
      }
      expect(result.verdict.kind).toBe('reject')
      expect(result.verdict.code).toBe('usage-budget-exhausted')
    } finally {
      await ctx.dispose('test')
    }
  })

  it('预算配了但未超 → pre-step 继续走 next（不误伤）', async () => {
    const ctx = await boot({
      events: [summary(1, 100)],
      config: { guard: { maxTurnCostMicroYuan: 10_000 } },
    })
    try {
      const input = {
        agent: {} as never,
        messages: [],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
        verdict: { kind: 'enter' as const, messages: [] },
      }
      const result = (await ctx.events.waterfall('agent/pre-step', input)) as { verdict: { kind: string } }
      expect(result.verdict.kind).toBe('enter')
    } finally {
      await ctx.dispose('test')
    }
  })

  it('预算全 0 → 不注册监听器（pre-step 原样通过）', async () => {
    const ctx = await boot()
    try {
      const input = {
        agent: {} as never,
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
        verdict: { kind: 'enter' as const, messages: [] },
      }
      const result = (await ctx.events.waterfall('agent/pre-step', input)) as { verdict: { kind: string } }
      expect(result.verdict.kind).toBe('enter')
    } finally {
      await ctx.dispose('test')
    }
  })
})

describe('obs:telemetry · span.jsonl 落盘', () => {
  it('相对路径按 run.jsonlDir 解析，一行一条 JSON', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bah-telemetry-'))
    const ctx = await boot({ jsonlDir: base, config: { spanLog: 'span.jsonl' } })
    try {
      const handle = ctx.get(TELEMETRY)
      expect(handle.spanLogPath).toBe(join(base, 'span.jsonl'))
      // 用采样率为 1 的名字：`policy.evaluate` 默认 0.1，可能整条被采样掉（那是设计行为）。
      handle.withSpan('http.request', { method: 'GET' }, () => undefined)
      const lines = readFileSync(join(base, 'span.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const row = JSON.parse(lines[0] as string) as Record<string, unknown>
      expect(row['name']).toBe('http.request')
      expect(row['source']).toBe('recorded')
      // 键序是钉死的（drop-in 断言：改键序 = 改导出格式）
      expect(Object.keys(row)[0]).toBe('traceId')
    } finally {
      await ctx.dispose('test')
      rmSync(base, { recursive: true, force: true })
    }
  })
})
