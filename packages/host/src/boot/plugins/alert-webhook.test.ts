import { describe, expect, it, vi } from 'vitest'

import { emitAlert } from '@bah/saga'

import { resetAlertStats, alertSamples } from './alert-stats.ts'
import { installAlertWebhook, isHttpUrl } from './alert-webhook.ts'

/** 等一轮微任务，让 `void deliver()` 跑完。 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('alert-webhook · URL 与投递', () => {
  it('只接受 http(s)', () => {
    expect(isHttpUrl('https://example.test/hook')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:1/hook')).toBe(true)
    expect(isHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })

  it('成功投递记 webhook；body 是单行 JSON', async () => {
    resetAlertStats()
    const calls: { url: string; body: string }[] = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') })
      return { ok: true } as Response
    })
    const dispose = installAlertWebhook('https://example.test/hook', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
    })
    try {
      emitAlert({ level: 'alert', metric: 'dlqDepth', detail: 'DLQ 深度 3' })
      await tick()
      expect(calls).toHaveLength(1)
      expect(JSON.parse(calls[0]!.body)).toMatchObject({
        level: 'alert',
        metric: 'dlqDepth',
        detail: 'DLQ 深度 3',
        source: 'bah-saga',
      })
      expect(alertSamples()).toContainEqual({ level: 'alert', result: 'webhook', count: 1 })
    } finally {
      dispose()
    }
  })

  it('同 (metric, detail) 在 60 秒内只发一次', async () => {
    resetAlertStats()
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response)
    let now = 1_000
    const dispose = installAlertWebhook('https://example.test/hook', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    })
    try {
      emitAlert({ level: 'alert', metric: 'dlqDepth', detail: 'same' })
      await tick()
      now += 1_000
      emitAlert({ level: 'alert', metric: 'dlqDepth', detail: 'same' })
      await tick()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      dispose()
    }
  })

  it('失败计数 failed，不抛给调用方', async () => {
    resetAlertStats()
    const fetchImpl = vi.fn(async () => {
      throw new Error('network')
    })
    const dispose = installAlertWebhook('https://example.test/hook', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [0],
      now: () => 1_000,
    })
    try {
      expect(() => emitAlert({ level: 'P0', metric: 'chainBreak', detail: 'broken' })).not.toThrow()
      await tick()
      expect(alertSamples()).toContainEqual({ level: 'P0', result: 'failed', count: 1 })
    } finally {
      dispose()
    }
  })

  it('重试退避走 sleep（定时器 unref），最终失败计数', async () => {
    resetAlertStats()
    const fetchImpl = vi.fn(async () => {
      throw new Error('network')
    })
    const dispose = installAlertWebhook('https://example.test/hook', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [1],
      now: () => 1_000,
    })
    try {
      emitAlert({ level: 'alert', detail: 'retry' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(alertSamples()).toContainEqual({ level: 'alert', result: 'failed', count: 1 })
    } finally {
      dispose()
    }
  })

  it('队列满丢最旧并记 failed（不无界堆内存）', async () => {
    resetAlertStats()
    // 第一条投递挂在 pending 上，后续事件只能排队。
    const pending = new Promise<Response>(() => undefined)
    const fetchImpl = vi.fn(() => pending)
    const dispose = installAlertWebhook('https://example.test/hook', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxQueue: 1,
      now: () => 1_000,
    })
    try {
      emitAlert({ level: 'alert', detail: 'first' })
      await tick()
      emitAlert({ level: 'alert', detail: 'second' })
      emitAlert({ level: 'alert', detail: 'third' })
      expect(alertSamples()).toContainEqual({ level: 'alert', result: 'failed', count: 1 })
    } finally {
      dispose()
    }
  })

  it('dispose 后不再投递', async () => {
    resetAlertStats()
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response)
    const dispose = installAlertWebhook('https://example.test/hook', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
    })
    dispose()
    emitAlert({ level: 'alert', detail: 'after dispose' })
    await tick()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
