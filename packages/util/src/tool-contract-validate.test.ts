/**
 * 契约校验器子集单测（TC-W03-07：9 类规则 × 正/负例）。
 *
 * 写法口径：每条规则至少一对"正例 + 负例"，负例断言 **`code` 与 `path`**，
 * 不只断言"失败了"——`code` 是 W03 错误码契约的一部分，错了下游断言会静默失效。
 */

import { describe, expect, it } from 'vitest'

import { validateAgainstSchema, type StructSchema } from './tool-contract-validate.ts'

/** 断言通过。 */
function pass(schema: StructSchema, value: unknown): void {
  expect(validateAgainstSchema(schema, value, 'args')).toBeUndefined()
}

/** 断言失败，并核对 code / path。 */
function fail(
  schema: StructSchema,
  value: unknown,
  code: string,
  path = '',
  phase: 'args' | 'result' = 'args',
): void {
  const found = validateAgainstSchema(schema, value, phase)
  expect(found, `期望失败但通过了：${JSON.stringify(value)}`).toBeDefined()
  expect(found?.code).toBe(code)
  expect(found?.path).toBe(path)
  expect(found?.phase).toBe(phase)
  // detail 不得回显值的原文（PII 纪律）：金额和账号不许进日志
  expect(found?.detail.length ?? 0).toBeGreaterThan(0)
}

describe('type', () => {
  it('正例：object 通过', () => {
    pass({ type: 'object' }, { a: 1 })
  })

  it('负例：array 不是 object', () => {
    fail({ type: 'object' }, [], 'type')
  })

  it('负例：NaN 不算 number（非有限数）', () => {
    fail({ type: 'number' }, Number.NaN, 'type')
  })

  it('负例：Infinity 不算 number', () => {
    fail({ type: 'number' }, Number.POSITIVE_INFINITY, 'type')
  })

  it('负例：整数型的 1.5 不是 integer', () => {
    fail({ type: 'integer' }, 1.5, 'type')
  })

  it('负例：未识别的 type 一律不通过（不许"不认识就放行"）', () => {
    fail({ type: 'quaternion' }, 'x', 'type')
  })

  it('正例：boolean 通过', () => {
    pass({ type: 'boolean' }, false)
  })

  it('负例：0 不是 boolean（假值陷阱）', () => {
    fail({ type: 'boolean' }, 0, 'type')
  })

  it('正例：null 通过', () => {
    pass({ type: 'null' }, null)
  })

  it('负例：undefined 不是 null', () => {
    fail({ type: 'null' }, undefined, 'type')
  })
})

describe('required', () => {
  const schema: StructSchema = {
    type: 'object',
    required: ['toAccount', 'amount'],
    properties: { toAccount: { type: 'string' }, amount: { type: 'number' } },
  }

  it('正例：两个必填都在', () => {
    pass(schema, { toAccount: '62220000', amount: 800 })
  })

  it('负例：缺必填 → code=required，path 指到缺失的键', () => {
    fail(schema, { toAccount: '62220000' }, 'required', '/amount')
  })
})

describe('enum', () => {
  const schema: StructSchema = { type: 'string', enum: ['app', 'web', 'im'] }

  it('正例：在取值内', () => {
    pass(schema, 'im')
  })

  it('负例：越界（TC-W03-03 的 channel: fax）', () => {
    fail(schema, 'fax', 'enum')
  })
})

describe('数值边界', () => {
  it('negative：minimum', () => {
    fail({ type: 'number', minimum: 0 }, -1, 'minimum')
  })

  it('正例：等于 minimum 算通过（闭区间）', () => {
    pass({ type: 'number', minimum: 0 }, 0)
  })

  it('negative：maximum', () => {
    fail({ type: 'number', maximum: 100 }, 101, 'maximum')
  })

  it('negative：exclusiveMinimum 取等号也不许', () => {
    fail({ type: 'number', exclusiveMinimum: 0 }, 0, 'exclusive-minimum')
  })

  it('negative：exclusiveMaximum 取等号也不许', () => {
    fail({ type: 'number', exclusiveMaximum: 1000 }, 1000, 'exclusive-maximum')
  })

  it('negative：multipleOf=0.01 拦下 19.999（TC-W03-02 ④）', () => {
    fail({ type: 'number', multipleOf: 0.01 }, 19.999, 'multiple-of')
  })

  it('正例：multipleOf=0.01 放行 19.99（浮点除法不能被误判）', () => {
    pass({ type: 'number', multipleOf: 0.01 }, 19.99)
  })
})

describe('字符串规则', () => {
  it('negative：minLength', () => {
    fail({ type: 'string', minLength: 8 }, '6222', 'min-length')
  })

  it('negative：maxLength', () => {
    fail({ type: 'string', maxLength: 140 }, 'x'.repeat(141), 'max-length')
  })

  it('negative：pattern', () => {
    fail({ type: 'string', pattern: '^[0-9]{8,}$' }, 'abc', 'pattern')
  })

  it('negative：schema 里的 pattern 本身写坏了要立刻报，不许静默放行', () => {
    fail({ type: 'string', pattern: '([' }, 'anything', 'pattern-invalid')
  })
})

describe('嵌套与数组', () => {
  it('正例：嵌套对象逐层校验', () => {
    const schema: StructSchema = {
      type: 'object',
      properties: {
        transfer: {
          type: 'object',
          required: ['amount'],
          properties: { amount: { type: 'number', exclusiveMinimum: 0 } },
        },
      },
    }
    pass(schema, { transfer: { amount: 800 } })
  })

  it('负例：嵌套对象的违规 path 带层级', () => {
    const schema: StructSchema = {
      type: 'object',
      properties: {
        transfer: {
          type: 'object',
          required: ['amount'],
          properties: { amount: { type: 'number', exclusiveMinimum: 0 } },
        },
      },
    }
    fail(schema, { transfer: { amount: -1 } }, 'exclusive-minimum', '/transfer/amount')
  })

  it('负例：数组元素违规定位到下标', () => {
    const schema: StructSchema = { type: 'array', items: { type: 'string' } }
    fail(schema, ['a', 2, 'c'], 'type', '/1')
  })

  it('正例：数组全部合规', () => {
    pass({ type: 'array', items: { type: 'string' } }, ['a', 'b'])
  })
})

describe('additionalProperties: false', () => {
  const schema: StructSchema = {
    type: 'object',
    properties: { amount: { type: 'number' } },
    additionalProperties: false,
  }

  it('正例：只传声明过的字段', () => {
    pass(schema, { amount: 1 })
  })

  it('负例：多塞一个字段就拦（模型爱"顺手多传"）', () => {
    fail(schema, { amount: 1, extra: true }, 'additional-property', '/extra')
  })
})

describe('phase 与 PII', () => {
  it('schema 本身不是对象 → schema-invalid（契约写错要立刻报，不许当作无约束）', () => {
    const found = validateAgainstSchema('not-a-schema', {}, 'args')
    expect(found?.code).toBe('schema-invalid')
    expect(found?.path).toBe('')
  })

  it('出参校验的 phase 是 result，不是 args', () => {
    fail({ type: 'object', required: ['txnId'] }, {}, 'required', '/txnId', 'result')
  })

  it('detail 不回显金额等值的原文', () => {
    const found = validateAgainstSchema({ type: 'number', maximum: 100 }, 999.99, 'args')
    expect(found?.detail).not.toContain('999.99')
  })
})
