/**
 * 告警接缝的最小契约（`alert/sink.ts`）。
 *
 * 这个文件只有类型与一个空实现，容易被当成"没有行为"而漏测；但它承担一条硬约束：
 * janitor / recon 在**未装配真实告警总线**时仍会被调度，出口必须静默吞下告警，
 * 不能抛错（抛错会把资金域的后台巡检打成失败），也不能往 stdout 刷噪声。
 */

import { describe, expect, it, vi } from 'vitest'

import { legacyAlertSink, registerAlertSink } from './index.ts'
import { noopAlertSink } from './sink.ts'

import type { AlertEvent } from './index.ts'

describe('alert/sink · 未装配总线时的空实现', () => {
  it('两个级别都必须静默吞下，不得抛错', () => {
    expect(() => noopAlertSink('P0', '补偿超时')).not.toThrow()
    expect(() => noopAlertSink('P1', 'DLQ 深度偏高')).not.toThrow()
  })

  it('返回 void，且不写控制台（后台巡检不该刷屏）', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(noopAlertSink('P0', '补偿超时')).toBeUndefined()

    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()

    log.mockRestore()
    error.mockRestore()
    warn.mockRestore()
  })
})

describe('alert/sink · 批 5 出口到告警汇的桥接', () => {
  it('P0 保持 P0，P1 降为常规 alert 级别，detail 原样透传', () => {
    const received: AlertEvent[] = []
    const dispose = registerAlertSink((event) => {
      received.push(event)
    })

    try {
      const sink = legacyAlertSink()
      sink('P0', '审计链断裂')
      sink('P1', '投影滞后')

      expect(received).toHaveLength(2)
      expect(received[0]).toMatchObject({ level: 'P0', detail: '审计链断裂' })
      // P1 在告警汇里统一为 `alert`：只有 P0 走电话升级路径。
      expect(received[1]).toMatchObject({ level: 'alert', detail: '投影滞后' })
    } finally {
      dispose()
    }
  })

  it('退订后不再收到告警（disposer 可交给 ctx.effect）', () => {
    const seen = vi.fn()
    const dispose = registerAlertSink(seen)

    legacyAlertSink()('P0', '第一次')
    dispose()
    legacyAlertSink()('P0', '第二次')

    expect(seen).toHaveBeenCalledTimes(1)
  })
})
