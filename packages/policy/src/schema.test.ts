/**
 * 输入契约与类型守卫（01 §2）。
 *
 * 这一层的口径是"**缺字段绝不兜底**"：任何必填缺失、类型错、越界、未知参数都必须抛
 * `policy-input-invalid`，而不是当成默认值继续算（fail-closed 的入口）。
 */

import { describe, expect, it } from 'vitest'

import {
  BANK_TIER_FIELDS,
  fieldOf,
  isObjectPrefix,
  MAX_AMOUNT_CENTS,
  validateInput,
  type BankTierInput,
  type ParamSpec,
} from './schema.ts'

const PARAMS: Record<string, ParamSpec> = { riskyCallThreshold: { min: 1, max: 100 } }

/** 一份合法输入。 */
function valid(): Record<string, unknown> {
  return {
    subject: { userId: 'u-1', sessionId: 's-1' },
    action: { name: 'transfer_create', declared: 'yellow' },
    preview: {
      amountCents: 80_000,
      dailyUsedCents: 0,
      dailyLimitCents: 500_000,
      payee: { binding: 'whitelist' },
    },
    state: { riskyCallsInTurn: 0, verifyLocked: false },
    limits: { dailyLimitCents: 500_000 },
    params: { riskyCallThreshold: 3 },
  }
}

/** 断言抛出物的错误码。 */
function expectCode(read: () => unknown, code: string): void {
  try {
    read()
  } catch (error) {
    expect((error as { code: string }).code).toBe(code)
    return
  }
  throw new Error('期望抛错，但没有抛')
}

/** 改一个字段后校验，返回错误码。 */
function codeOfInput(mutate: (input: Record<string, unknown>) => void): string {
  const input = valid()
  mutate(input)
  try {
    validateInput(input, PARAMS)
  } catch (error) {
    return (error as { code: string }).code
  }
  throw new Error('期望抛错，但没有抛')
}

describe('validateInput', () => {
  it('合法输入 → 归一化对象（未知字段被丢弃）', () => {
    const input = { ...valid(), extra: 'ignored' }
    const result = validateInput(input, PARAMS)
    expect(result.subject.userId).toBe('u-1')
    expect(result.action.declared).toBe('yellow')
    expect(result.preview?.payee.binding).toBe('whitelist')
    expect('extra' in result).toBe(false)
  })

  it('非对象根直接拒绝', () => {
    expectCode(() => validateInput(null, PARAMS), 'policy-input-invalid')
    expectCode(() => validateInput([], PARAMS), 'policy-input-invalid')
    expectCode(() => validateInput('x', PARAMS), 'policy-input-invalid')
  })

  it('四个必填子树缺失都拒绝', () => {
    expect(codeOfInput((input) => delete input['subject'])).toBe('policy-input-invalid')
    expect(codeOfInput((input) => delete input['action'])).toBe('policy-input-invalid')
    expect(codeOfInput((input) => delete input['state'])).toBe('policy-input-invalid')
    expect(codeOfInput((input) => delete input['limits'])).toBe('policy-input-invalid')
  })

  it('主体字段必须是非空字符串', () => {
    expect(codeOfInput((input) => ((input['subject'] as Record<string, unknown>)['userId'] = ''))).toBe(
      'policy-input-invalid',
    )
    expect(
      codeOfInput((input) => ((input['subject'] as Record<string, unknown>)['sessionId'] = 1)),
    ).toBe('policy-input-invalid')
  })

  it('工具名/声明级别/绑定状态都必须是枚举成员', () => {
    expect(codeOfInput((input) => ((input['action'] as Record<string, unknown>)['name'] = ''))).toBe(
      'policy-input-invalid',
    )
    expect(
      codeOfInput((input) => ((input['action'] as Record<string, unknown>)['declared'] = 'blue')),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput(
        (input) =>
          (((input['preview'] as Record<string, unknown>)['payee'] as Record<string, unknown>)['binding'] =
            'other'),
      ),
    ).toBe('policy-input-invalid')
  })

  it('金额只接受非负整数分，且有上限', () => {
    expect(
      codeOfInput((input) => ((input['preview'] as Record<string, unknown>)['amountCents'] = 1.5)),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput((input) => ((input['preview'] as Record<string, unknown>)['amountCents'] = -1)),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput(
        (input) =>
          ((input['preview'] as Record<string, unknown>)['dailyLimitCents'] = MAX_AMOUNT_CENTS + 1),
      ),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput((input) => ((input['preview'] as Record<string, unknown>)['dailyUsedCents'] = '0')),
    ).toBe('policy-input-invalid')
  })

  it('preview 缺 payee / 非对象都拒绝', () => {
    expect(
      codeOfInput((input) => delete (input['preview'] as Record<string, unknown>)['payee']),
    ).toBe('policy-input-invalid')
    expect(codeOfInput((input) => (input['preview'] = 'x'))).toBe('policy-input-invalid')
  })

  it('状态字段：风险计数受 0..100 约束、锁定必须是布尔', () => {
    expect(
      codeOfInput((input) => ((input['state'] as Record<string, unknown>)['riskyCallsInTurn'] = 101)),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput((input) => ((input['state'] as Record<string, unknown>)['riskyCallsInTurn'] = -1)),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput((input) => ((input['state'] as Record<string, unknown>)['verifyLocked'] = 'false')),
    ).toBe('policy-input-invalid')
  })

  it('params 必须恰好是声明的那几个，且值在边界内', () => {
    expect(codeOfInput((input) => delete input['params'])).toBe('policy-input-invalid')
    expect(codeOfInput((input) => (input['params'] = []))).toBe('policy-input-invalid')
    expect(codeOfInput((input) => (input['params'] = {}))).toBe('policy-input-invalid')
    expect(
      codeOfInput((input) => (input['params'] = { riskyCallThreshold: 3, extra: 1 })),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput((input) => (input['params'] = { riskyCallThreshold: 0 })),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput((input) => (input['params'] = { riskyCallThreshold: 101 })),
    ).toBe('policy-input-invalid')
    expect(
      codeOfInput((input) => (input['params'] = { riskyCallThreshold: 2.5 })),
    ).toBe('policy-input-invalid')
  })

  it('多参数按名字排序归一（顺序不影响结果）', () => {
    const params = { bThreshold: { min: 1, max: 10 }, aThreshold: { min: 0, max: 5 } }
    const input = { ...valid(), params: { bThreshold: 2, aThreshold: 1 } }
    const result = validateInput(input, params)
    expect(result.params).toEqual({ aThreshold: 1, bThreshold: 2 })
  })

  it('非转账类可以没有 preview', () => {
    const input = valid()
    delete input['preview']
    input['action'] = { name: 'wealth_purchase', declared: 'red' }
    const result: BankTierInput = validateInput(input, PARAMS)
    expect(result.preview).toBeUndefined()
  })

  it('返回对象被深冻结（求值器承诺不改输入）', () => {
    const result = validateInput(valid(), PARAMS)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.subject)).toBe(true)
    expect(Object.isFrozen(result.preview?.payee)).toBe(true)
  })
})

describe('字段表', () => {
  it('fieldOf 能取到已知字段，未知返回 undefined', () => {
    expect(fieldOf('preview.amountCents')?.type.kind).toBe('int')
    expect(fieldOf('level')?.type.kind).toBe('enum')
    expect(fieldOf('nope')).toBeUndefined()
  })

  it('对象前缀可判定（不能直接引用 preview）', () => {
    expect(isObjectPrefix('preview')).toBe(true)
    expect(isObjectPrefix('preview.payee')).toBe(true)
    expect(isObjectPrefix('level')).toBe(false)
  })

  it('字段表里没有 PII 与游离主体属性（01 §2.1 的"刻意不放"）', () => {
    const paths = BANK_TIER_FIELDS.map((field) => field.path)
    expect(paths.some((path) => path.includes('payee.name'))).toBe(false)
    expect(paths.some((path) => path.includes('memo'))).toBe(false)
    expect(paths.some((path) => path.startsWith('tenant'))).toBe(false)
  })
})
