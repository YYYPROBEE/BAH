/**
 * 受限表达式求值器（`analysis_calc` 的默认 seam）。
 *
 * 覆盖：优先级 / 一元 / 括号 / data 路径 / 五个函数 / 预算 / 超时 / 非法输入。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { DEFAULT_MAX_OPERATIONS, evaluateExpression } from './compute.ts'

/** 带默认预算的求值。 */
function run(code: string, data?: Record<string, unknown>, overrides: { timeoutMs?: number; maxOperations?: number } = {}): number {
  return evaluateExpression({
    code,
    ...(data === undefined ? {} : { data }),
    limits: {
      timeoutMs: overrides.timeoutMs ?? 1_000,
      maxOperations: overrides.maxOperations ?? DEFAULT_MAX_OPERATIONS,
    },
  }).value
}

describe('受限表达式求值', () => {
  it('算术优先级、括号、一元与取模', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
    expect(run('-2 * -3')).toBe(6)
    expect(run('10 % 4')).toBe(2)
    expect(run('1.5 + 2.25')).toBe(3.75)
  })

  it('data 路径：点号 / 下标 / 嵌套', () => {
    expect(run('data.a + data.b', { a: 1, b: 2 })).toBe(3)
    expect(run("data['a-b'] * 2", { 'a-b': 4 })).toBe(8)
    expect(run('data.items[1]', { items: [1, 2, 3] })).toBe(2)
  })

  it('函数：sum / avg / min / max / round / abs', () => {
    expect(run('sum(1, 2, 3)')).toBe(6)
    expect(run('avg(2, 4)')).toBe(3)
    expect(run('min(3, 1, 2)')).toBe(1)
    expect(run('max(3, 1, 2)')).toBe(3)
    expect(run('round(2.6)')).toBe(3)
    expect(run('abs(-3)')).toBe(3)
  })

  it('非法：未知标识符 / 未知函数 / 除零 / 语法不完整', () => {
    expect(captureThrown(() => run('foo + 1')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('nope(1)')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('1 / 0')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('1 +')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('(1 + 2')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('1 2')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('1 @ 2')).code).toBe('compute-invalid')
  })

  it('数据路径缺失 / 非数字：compute-data-missing', () => {
    expect(captureThrown(() => run('data.missing + 1', { yes: 1 })).code).toBe('compute-data-missing')
    expect(captureThrown(() => run('data.text + 1', { text: 'x' })).code).toBe('compute-data-missing')
    expect(captureThrown(() => run('data.a.b + 1', { a: 1 })).code).toBe('compute-data-missing')
  })

  it('avg / min / max / round 的参数个数校验', () => {
    expect(captureThrown(() => run('avg()')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('min()')).code).toBe('compute-invalid')
    expect(captureThrown(() => run('round(1, 2)')).code).toBe('compute-invalid')
  })

  it('预算：运算数超过上限 → compute-limit', () => {
    const error = captureThrown(() => run('1 + 2 + 3 + 4', undefined, { maxOperations: 2 }))
    expect(error.code).toBe('compute-limit')
  })

  it('超时：墙钟预算耗尽 → compute-timeout（每 256 次运算检查）', () => {
    const code = Array.from({ length: 300 }, () => '1').join(' + ')
    const error = captureThrown(() => run(code, undefined, { timeoutMs: -1 }))
    expect(error.code).toBe('compute-timeout')
  })

  it('非有限结果 → compute-result-invalid', () => {
    expect(captureThrown(() => run('1e308 * 1e308')).code).toBe('compute-result-invalid')
  })

  it('超长表达式拒绝', () => {
    expect(captureThrown(() => run('1'.repeat(2_001))).code).toBe('compute-invalid')
  })
})
