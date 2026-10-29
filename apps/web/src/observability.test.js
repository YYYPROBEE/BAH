/**
 * 轮询控制器（03 §S3.2 的 9 条 + 超时 / 状态迁移）。
 *
 * 全部用 fake timers 与注入 `now()`：不真等 2 秒，也不依赖真实时钟。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createObservability } from './observability.js'

/** 可控的假 API：默认全成功，可逐次改行为。 */
function makeApi() {
  const api = {
    metrics: vi.fn(async () => ({ ok: true, data: { turns: 1 } })),
    trace: vi.fn(async () => ({ ok: true, data: { clock: 'trusted', roots: [] } })),
  }
  return api
}

/** 建控制器（时钟可手动推进）。 */
function setup(overrides = {}) {
  const api = overrides.api ?? makeApi()
  const states = []
  let clock = 0
  const obs = createObservability({
    api,
    onState: (state) => states.push(state),
    now: () => clock,
    ...overrides.options,
  })
  return {
    api,
    obs,
    states,
    tick(ms) {
      clock += ms
      return vi.advanceTimersByTimeAsync(ms)
    },
    flush() {
      return vi.advanceTimersByTimeAsync(0)
    },
    at() {
      return clock
    },
    setClock(value) {
      clock = value
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('轮询节奏与幂等', () => {
  it('start() 两次只发一轮请求', async () => {
    const ctx = setup()
    ctx.obs.start()
    ctx.obs.start()
    await ctx.flush()
    expect(ctx.api.metrics).toHaveBeenCalledTimes(1)
    expect(ctx.api.trace).toHaveBeenCalledTimes(1)
  })

  it('成功后 2s 再抓一次；1999ms 时还没动', async () => {
    const ctx = setup()
    ctx.obs.start()
    await ctx.flush()
    expect(ctx.api.metrics).toHaveBeenCalledTimes(1)

    await ctx.tick(1999)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(1)
    await ctx.tick(1)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(2)
  })

  it('连续失败按 2/2/4/8/16/30s 退避', async () => {
    const api = makeApi()
    api.metrics.mockImplementation(async () => ({ ok: false, code: 'http-500' }))
    api.trace.mockImplementation(async () => ({ ok: false, code: 'http-500' }))
    const ctx = setup({ api })

    ctx.obs.start()
    await ctx.flush()
    expect(ctx.api.metrics).toHaveBeenCalledTimes(1)

    await ctx.tick(2000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(2)
    await ctx.tick(2000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(3)
    await ctx.tick(4000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(4)
    await ctx.tick(8000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(5)
    await ctx.tick(16000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(6)
    await ctx.tick(30000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(7)
    // 封顶在 30s
    await ctx.tick(30000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(8)
  })

  it('失败一轮后成功：间隔复位到 2s', async () => {
    const api = makeApi()
    api.metrics.mockImplementationOnce(async () => ({ ok: false, code: 'http-500' }))
    const ctx = setup({ api })

    ctx.obs.start()
    await ctx.flush()
    await ctx.tick(2000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(2)

    await ctx.tick(2000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(3)
  })

  it('请求超时（3s）按失败处理，状态 offline + code=timeout', async () => {
    const api = {
      metrics: () => new Promise(() => {}),
      trace: () => new Promise(() => {}),
    }
    const ctx = setup({ api })
    ctx.obs.start()
    await ctx.tick(3000)
    expect(ctx.states.at(-1).status).toBe('offline')
    expect(ctx.states.at(-1).error.code).toBe('timeout')
  })
})

describe('启停与可见性', () => {
  it('setActive(false) 立即停表，之后不再发请求', async () => {
    const ctx = setup()
    ctx.obs.setActive(true)
    await ctx.flush()
    ctx.obs.setActive(false)
    await ctx.tick(10000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(1)
  })

  it('document.hidden 时停表，恢复可见后重启', async () => {
    const ctx = setup()
    ctx.obs.start()
    await ctx.flush()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await ctx.tick(10000)
    expect(ctx.api.metrics).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await ctx.flush()
    expect(ctx.api.metrics).toHaveBeenCalledTimes(2)
  })
})

describe('部分失败与陈旧', () => {
  it('metrics 成功 / trace 失败：指标更新、轨迹保留旧值', async () => {
    const api = makeApi()
    api.trace.mockResolvedValueOnce({ ok: true, data: { clock: 'trusted', roots: [{ span: { spanId: 'old' } }] } })
    const ctx = setup({ api })

    ctx.obs.start()
    await ctx.flush()
    expect(ctx.obs.state().trace.roots).toHaveLength(1)

    api.metrics.mockResolvedValueOnce({ ok: true, data: { turns: 2 } })
    api.trace.mockResolvedValueOnce({ ok: false, code: 'trace-too-large' })
    await ctx.tick(2000)

    const state = ctx.obs.state()
    expect(state.metrics.turns).toBe(2)
    expect(state.trace.roots).toHaveLength(1)
    expect(state.status).toBe('online')
    expect(state.error.code).toBe('trace-too-large')
  })

  it('refreshOnce() 1s 内两次只多抓一轮', async () => {
    const ctx = setup()
    ctx.obs.start()
    await ctx.flush()
    expect(ctx.api.metrics).toHaveBeenCalledTimes(1)

    ctx.obs.refreshOnce()
    await ctx.flush()
    expect(ctx.api.metrics).toHaveBeenCalledTimes(2)

    ctx.obs.refreshOnce()
    await ctx.flush()
    expect(ctx.api.metrics).toHaveBeenCalledTimes(2)

    await ctx.tick(1000)
    ctx.obs.refreshOnce()
    await ctx.flush()
    expect(ctx.api.metrics).toHaveBeenCalledTimes(3)
  })

  it('连续 3 次失败后 staleSec ≥ 6', async () => {
    const api = makeApi()
    const ctx = setup({ api })
    ctx.setClock(0)
    ctx.obs.start()
    await ctx.flush()

    api.metrics.mockImplementation(async () => ({ ok: false, code: 'http-500' }))
    api.trace.mockImplementation(async () => ({ ok: false, code: 'http-500' }))

    await ctx.tick(2000)
    await ctx.tick(2000)
    await ctx.tick(4000)
    expect(ctx.obs.state().status).toBe('offline')
    expect(ctx.obs.state().staleSec).toBeGreaterThanOrEqual(6)
  })

  it('初始状态 connecting，首轮成功后 online', async () => {
    const ctx = setup()
    expect(ctx.obs.state()).toMatchObject({ metrics: null, trace: null, status: 'connecting', staleSec: null })

    ctx.obs.start()
    await ctx.flush()
    expect(ctx.obs.state().status).toBe('online')
    expect(ctx.obs.state().metrics.turns).toBe(1)
  })
})
