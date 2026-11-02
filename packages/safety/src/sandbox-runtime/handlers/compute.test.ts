/**
 * 计算执行体的载荷闸门（沙箱运行时 ·）。
 *
 * 载荷跨过 `worker_threads` 边界后是**完全不可信**的：`SANDBOX_HANDLER.run` 必须先
 * 把形状校完再进表达式求值器，任何缺字段 / 类型错都必须是 `program-invalid`，
 * 而不是在求值阶段抛 TypeError 或让 `undefined` 参与运算。
 */

import { describe, expect, it } from 'vitest'

import { ProgramError } from '../language.ts'
import { SANDBOX_HANDLER } from './compute.ts'

/** 抓 `ProgramError`（它不是 `BahError`，不能走 `captureThrown`）。 */
function programErrorOf(run: () => unknown): ProgramError {
  try {
    run()
  } catch (error) {
    if (error instanceof ProgramError) return error
    throw error
  }
  throw new Error('期望抛 ProgramError，但没有抛')
}

/** 合法 limits。 */
const LIMITS = { timeoutMs: 1_000, maxOperations: 100 }

describe('compute 执行体：合法载荷', () => {
  it('跑通受限表达式并返回数值与运算数', () => {
    const result = SANDBOX_HANDLER.run({
      code: 'sum(data.food, data.rent)',
      data: { food: 120, rent: 3_000 },
      limits: LIMITS,
    })
    expect(result).toEqual({ value: 3_120, operations: expect.any(Number) })
  })

  it('data 可省略（纯常量表达式）', () => {
    expect(SANDBOX_HANDLER.run({ code: '1 + 2', limits: LIMITS }).value).toBe(3)
  })
})

describe('compute 执行体：载荷形状校验', () => {
  it('载荷必须是对象', () => {
    for (const payload of [null, undefined, 'x', 1, true]) {
      const error = programErrorOf(() => SANDBOX_HANDLER.run(payload))
      expect(error.code).toBe('program-invalid')
      expect(error.message).toBe('计算载荷必须是对象')
    }
  })

  it('code 必须是字符串（数组虽能当对象用，但缺 code 同样拒绝）', () => {
    for (const code of [undefined, null, 1, {}, []]) {
      const error = programErrorOf(() => SANDBOX_HANDLER.run({ code, limits: LIMITS }))
      expect(error.code).toBe('program-invalid')
      expect(error.message).toBe('计算载荷缺少字符串 code')
    }
  })

  it('limits 必须是对象', () => {
    for (const limits of [undefined, null, 'x', 1]) {
      const error = programErrorOf(() => SANDBOX_HANDLER.run({ code: '1', limits }))
      expect(error.code).toBe('program-invalid')
      expect(error.message).toBe('计算载荷缺少 limits')
    }
  })

  it('timeoutMs 必须是正有限数', () => {
    for (const timeoutMs of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      const error = programErrorOf(() =>
        SANDBOX_HANDLER.run({ code: '1', limits: { timeoutMs, maxOperations: 10 } }),
      )
      expect(error.code).toBe('program-invalid')
      expect(error.message).toBe('limits.timeoutMs 必须是正数')
    }
  })

  it('maxOperations 必须是正整数', () => {
    for (const maxOperations of [undefined, 0, -1, 1.5, Number.NaN, '10']) {
      const error = programErrorOf(() =>
        SANDBOX_HANDLER.run({ code: '1', limits: { timeoutMs: 1_000, maxOperations } }),
      )
      expect(error.code).toBe('program-invalid')
      expect(error.message).toBe('limits.maxOperations 必须是正整数')
    }
  })

  it('data 给了就必须是对象（null / 字符串都拒）', () => {
    for (const data of [null, 'x', 1]) {
      const error = programErrorOf(() => SANDBOX_HANDLER.run({ code: '1', data, limits: LIMITS }))
      expect(error.code).toBe('program-invalid')
      expect(error.message).toBe('计算载荷的 data 必须是对象')
    }
  })
})
