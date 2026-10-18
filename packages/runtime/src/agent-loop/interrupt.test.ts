/**
 * 中断：每 turn 一个 AbortController（施工单 04 §3「中断」/ T-LOOP-005 的传播前提）。
 *
 * 三条被钉住的语义：新 turn 换新 controller（旧 latch 失效）、无 turn 时 abort 是无操作、
 * `end()` 之后信号不再代表任何在跑的 turn。
 */

import { describe, expect, it } from 'vitest'

import { TurnAbort } from './interrupt.ts'

describe('TurnAbort · controller 生命周期', () => {
  it('begin 给出未取消信号；abort 取消它并返回 true（重复 abort 返回 false）', () => {
    const abort = new TurnAbort()
    const signal = abort.begin()

    expect(abort.active).toBe(true)
    expect(abort.generation).toBe(1)
    expect(signal.aborted).toBe(false)

    expect(abort.abort('用户按下停止')).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(abort.abort('再按一次')).toBe(false)
  })

  it('没有 turn 在跑时 abort 是无操作（不排队、不抛错）', () => {
    const abort = new TurnAbort()
    expect(abort.active).toBe(false)
    expect(abort.abort()).toBe(false)
    // 无 turn 时 signal 是"永不取消"的
    expect(abort.signal.aborted).toBe(false)
  })

  it('新 turn 换新 controller：旧 latch 失效，新信号未被取消', () => {
    const abort = new TurnAbort()
    const first = abort.begin()
    abort.abort('第一轮被中断')
    abort.end()

    const second = abort.begin()
    expect(abort.generation).toBe(2)
    expect(second).not.toBe(first)
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)

    // 第二轮不被上一轮的中断影响
    expect(abort.abort('第二轮被中断')).toBe(true)
    expect(second.aborted).toBe(true)
  })

  it('end 之后不再有活动 turn：abort 不命中任何 controller', () => {
    const abort = new TurnAbort()
    const signal = abort.begin()
    abort.end()

    expect(abort.active).toBe(false)
    expect(signal.aborted).toBe(false)
    expect(abort.abort()).toBe(false)
    expect(abort.signal.aborted).toBe(false)
  })

  it('取消原因写进 signal.reason（审计与排障可解释）', () => {
    const abort = new TurnAbort()
    const signal = abort.begin()
    abort.abort('额度用尽')
    expect(signal.reason).toBe('额度用尽')
  })
})
