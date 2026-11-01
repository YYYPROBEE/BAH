/**
 * 错误归一化唯一实现的行为口径（`errorCodeOf` / `reasonOf` / `assertNever`）。
 *
 * 为什么必须单独钉这三个函数：它们是全仓唯一的「抛出物 → 理由码 / 理由文本」出口
 * （`errorCodeOf` 15 个文件、`reasonOf` 23 个文件、`assertNever` 56 个文件在用），
 * 审计事件、门禁分支与前端错误文案都只认这里产出的字符串。
 *
 * 归一化松动的表现**不是崩溃**，而是账本里出现空理由码、`'undefined'`、
 * 或把「未处理的判别标签」变成静默返回——事后从审计链里查不出来。
 * 门禁 `verify-single-error-normalization` 只保证「没人另起一份实现」，
 * 保证不了「这一份的分支口径」，所以分支必须有用例。
 */

import { describe, expect, it } from 'vitest'

import { BahError, assertNever, errorCodeOf, reasonOf } from './errors.ts'

/** 取错误码（非 BahError 直接让用例红，与 `tenant.test.ts` 同一手法）。 */
function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof BahError) return error.code
    throw error
  }
  throw new Error('期望抛错，但没有抛')
}

describe('errorCodeOf：抛出物 → 理由码', () => {
  it('BahError 原样带出自己的 code（不降级成兜底码）', () => {
    expect(errorCodeOf(new BahError('ticket-expired', '票据过期'), 'tool-failed')).toBe('ticket-expired')
  })

  it('BahError 子类也按 instanceof 取码（跨层继承不许丢语义）', () => {
    class PipelineError extends BahError {}
    expect(errorCodeOf(new PipelineError('pipeline-refused', '拒绝'), 'tool-failed')).toBe('pipeline-refused')
  })

  it('跨进程错误没有本仓原型：按形状取 code（provider 抛的就是这种）', () => {
    expect(errorCodeOf({ code: 'upstream-503' }, 'tool-failed')).toBe('upstream-503')
  })

  it('空串 code 不许被采纳（账本里不能出现空理由码）', () => {
    expect(errorCodeOf({ code: '' }, 'tool-failed')).toBe('tool-failed')
  })

  it('非字符串 code 不许被采纳（Node 系统错误的 code 有时是数字）', () => {
    expect(errorCodeOf({ code: 42 }, 'tool-failed')).toBe('tool-failed')
    expect(errorCodeOf({ code: null }, 'verify-failed')).toBe('verify-failed')
  })

  it('兜底码保持可判别性：同一抛出物、不同兜底码得到不同结论', () => {
    // 调用方按 code 分支决定是否重试，所以 `tool-failed` 与 `verify-failed` 不许被统一。
    const thrown = new Error('boom')
    expect(errorCodeOf(thrown, 'tool-failed')).toBe('tool-failed')
    expect(errorCodeOf(thrown, 'verify-failed')).toBe('verify-failed')
  })

  it('JS 允许抛任何东西：字符串 / null / undefined / 普通对象一律走兜底码', () => {
    for (const junk of ['plain string', null, undefined, { message: 'no code' }, 0, Number.NaN]) {
      expect(errorCodeOf(junk, 'tool-failed'), JSON.stringify(String(junk))).toBe('tool-failed')
    }
  })
})

describe('reasonOf：抛出物 → 可读理由', () => {
  it('Error 取 message', () => {
    expect(reasonOf(new BahError('no-identity', '主体未绑定'))).toBe('主体未绑定')
  })

  it('message 为空的 Error 退回 name（理由字段不许是空串）', () => {
    expect(reasonOf(new Error(''))).toBe('Error')
    const typed = new TypeError('')
    expect(reasonOf(typed)).toBe(typed.name)
  })

  it('非 Error 也留文本：null / undefined / 对象都不许变成空', () => {
    expect(reasonOf(null)).toBe('null')
    expect(reasonOf(undefined)).toBe('undefined')
    expect(reasonOf('boom')).toBe('boom')
    expect(reasonOf({ a: 1 })).toBe('[object Object]')
  })
})

describe('assertNever：封闭联合的穷尽性收尾', () => {
  it('抛结构化错误（带 code，不是裸 Error），且把 context 与越界值都写进消息', () => {
    const error = (() => {
      try {
        assertNever('weekly' as never, 'recurrence.every')
      } catch (thrown) {
        return thrown as BahError
      }
      throw new Error('期望抛错，但没有抛')
    })()
    expect(error.code).toBe('unreachable-branch')
    expect(error.message).toContain('recurrence.every')
    expect(error.message).toContain('weekly')
    expect(error.detail).toMatchObject({ context: 'recurrence.every' })
  })

  it('缺省 context 也能抛（调用方漏传不许变成静默）', () => {
    expect(codeOf(() => assertNever('x' as never))).toBe('unreachable-branch')
  })
})
