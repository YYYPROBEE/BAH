/**
 * `formatWaited` 纯函数（B3）。
 *
 * 边界比正常值重要：客户端时钟回拨 / 负等待不能显示成 `-0:01`。
 */

import { describe, expect, it } from 'vitest'

import { formatWaited, reasonLabelOf } from './format.js'

describe('formatWaited', () => {
  it('0 / 59999 / 60000 / 3600000', () => {
    expect(formatWaited(0)).toBe('0:00')
    expect(formatWaited(59_999)).toBe('0:59')
    expect(formatWaited(60_000)).toBe('1:00')
    expect(formatWaited(3_600_000)).toBe('1:00:00')
  })

  it('小时以上带 h:mm:ss，且分钟/秒补零', () => {
    expect(formatWaited(3_661_000)).toBe('1:01:01')
    expect(formatWaited(45_296_000)).toBe('12:34:56')
  })

  it('负数 / NaN / 非数字一律按 0（时钟回拨不显示负数）', () => {
    expect(formatWaited(-1)).toBe('0:00')
    expect(formatWaited(Number.NaN)).toBe('0:00')
    expect(formatWaited('1000')).toBe('0:00')
    expect(formatWaited(undefined)).toBe('0:00')
  })
})

/**
 * `reasonLabelOf` 理由码翻译（B 端可读性）。
 *
 * 两条都得钉：
 * 1. 表内的码翻成人话——工具卡与移动壳直接把这串字甩在界面上，
 *    用户看到 `approval-unavailable` 只会以为"银行坏了"；
 * 2. **表外的码原样返回**——宁可露一个陌生码，也不编一句听起来像业务结论的中文
 *    （编出来的"余额不足"可能让用户以为真被扣过钱）。
 */
describe('reasonLabelOf', () => {
  it('审批与工具的常见理由码翻成人话', () => {
    expect(reasonLabelOf('approval-unavailable')).toBe('审批无人应答')
    expect(reasonLabelOf('approval-timeout')).toBe('审批超时未应答')
    expect(reasonLabelOf('approval-rejected')).toBe('审批被拒绝')
    expect(reasonLabelOf('insufficient-funds')).toBe('余额不足')
    expect(reasonLabelOf('turn-rate-limited')).toBe('操作太频繁')
    expect(reasonLabelOf('tool-result-invalid')).toBe('结果不合规')
  })

  it('表外的码原样返回（不翻译、不吞、不编）', () => {
    for (const code of ['PRV-002', 'unknown-reason-code', 'saga-node-failed']) {
      expect(reasonLabelOf(code)).toBe(code)
    }
  })

  it('undefined / null / 非字符串：按空串处理，不抛错也不显示 "undefined"', () => {
    expect(reasonLabelOf(undefined)).toBe('')
    expect(reasonLabelOf(null)).toBe('')
    expect(reasonLabelOf(42)).toBe('42')
  })
})
