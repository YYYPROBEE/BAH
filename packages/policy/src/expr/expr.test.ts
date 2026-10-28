/**
 * 表达式语言：词法 / 语法 / 类型 / 求值（01 §5）。
 *
 * 覆盖策略是"每个错误码至少一条 + 每个分支至少一次"，因为 `packages/policy/src/**`
 * 在覆盖率强制名单里（逐文件 100% 行/语句/函数）。
 */

import { describe, expect, it } from 'vitest'

import { canonicalJson } from '@bah/util'

import { checkCondition, describeType, typeOf, type ExprTypeInfo } from './check.ts'
import { evaluateCondition, evaluateExpr, kindOf, type EvalScope } from './eval.ts'
import { tokenize } from './lexer.ts'
import { parseExpression, toIr, type ExprNode, type IrExpr } from './parser.ts'
import type { ParamSpec } from '../schema.ts'

const PARAMS: Record<string, ParamSpec> = { riskyCallThreshold: { min: 1, max: 100 } }

/** 解析 + 转 IR（便于断言语义，不受括号/空格影响）。 */
function ir(source: string): IrExpr {
  return toIr(parseExpression(source))
}

/** 类型检查（默认不带 requires）。 */
function check(source: string, requires: readonly string[] = []): ExprTypeInfo {
  return checkCondition(parseExpression(source), { params: PARAMS, requires: new Set(requires) })
}

/** 取抛出物的错误码。 */
function codeOf(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    return (error as { code: string }).code
  }
  throw new Error('期望抛错，但没有抛')
}

/** 取抛出物的完整信息。 */
function errorOf(read: () => unknown): { code: string; message: string; detail: Record<string, unknown> } {
  try {
    read()
  } catch (error) {
    const shaped = error as { code: string; message: string; detail: Record<string, unknown> }
    return { code: shaped.code, message: shaped.message, detail: shaped.detail }
  }
  throw new Error('期望抛错，但没有抛')
}

const SCOPE: EvalScope = {
  subject: { userId: 'u-1', sessionId: 's-1' },
  action: { name: 'transfer_create', declared: 'yellow' },
  preview: {
    amountCents: 200_001,
    dailyUsedCents: 300_000,
    dailyLimitCents: 500_000,
    payee: { binding: 'whitelist' },
  },
  state: { riskyCallsInTurn: 3, verifyLocked: false },
  limits: { dailyLimitCents: 500_000 },
  params: { riskyCallThreshold: 3 },
  level: 'yellow',
  reason: 'declared',
}

describe('词法', () => {
  it('切出路径/整数/字符串/布尔/运算符', () => {
    const tokens = tokenize('preview.amountCents + 10 > 5 && binding == "new" || true')
    expect(tokens.map((token) => token.value)).toEqual([
      'preview',
      '.',
      'amountCents',
      '+',
      '10',
      '>',
      '5',
      '&&',
      'binding',
      '==',
      'new',
      '||',
      'true',
      '',
    ])
    expect(tokens.map((token) => token.kind)).toEqual([
      'ident',
      'punct',
      'ident',
      'punct',
      'int',
      'punct',
      'int',
      'punct',
      'ident',
      'punct',
      'string',
      'punct',
      'ident',
      'eof',
    ])
  })

  it('字符串转义只允许白名单', () => {
    const tokens = tokenize('"a\\"b\\\\c\\n\\t\\u0041"')
    expect(tokens[0]?.value).toBe('a"b\\c\n\tA')
  })

  it('浮点 / 科学计数 / 前导零 / 超范围整数都在词法层拒绝', () => {
    expect(codeOf(() => tokenize('1.5'))).toBe('policy-parse-error')
    expect(errorOf(() => tokenize('1.5')).message).toContain('不支持小数')
    expect(codeOf(() => tokenize('1e3'))).toBe('policy-parse-error')
    expect(codeOf(() => tokenize('1E3'))).toBe('policy-parse-error')
    expect(codeOf(() => tokenize('007'))).toBe('policy-parse-error')
    expect(codeOf(() => tokenize('9007199254740992'))).toBe('policy-parse-error')
  })

  it('正则运算符与未知字符分开报码', () => {
    expect(codeOf(() => tokenize('a ~= b'))).toBe('policy-unknown-operator')
    expect(codeOf(() => tokenize('a # b'))).toBe('policy-parse-error')
  })

  it('未闭合/坏转义/坏 unicode 都报解析错误', () => {
    expect(codeOf(() => tokenize('"abc'))).toBe('policy-parse-error')
    expect(codeOf(() => tokenize('"a\\x"'))).toBe('policy-parse-error')
    expect(codeOf(() => tokenize('"\\u12"'))).toBe('policy-parse-error')
  })

  it('超长表达式与超长字符串按上限拒绝', () => {
    expect(codeOf(() => tokenize(`1${' + 1'.repeat(2000)}`))).toBe('policy-limit-exceeded')
    expect(codeOf(() => tokenize(`"${'a'.repeat(1025)}"`))).toBe('policy-limit-exceeded')
  })

  it('控制字符按上限拒绝（防注入型载荷）', () => {
    expect(codeOf(() => tokenize('a\u0007b'))).toBe('policy-limit-exceeded')
  })

  it('空白（含换行）不产生词法单元', () => {
    expect(tokenize(' 1\n+\t2\r\n').map((token) => token.value)).toEqual(['1', '+', '2', ''])
  })
})

describe('语法与优先级', () => {
  it('乘除优先于加减、比较低于算术、&& 低于比较', () => {
    expect(canonicalJson(ir('1 + 2 * 3 > 4 && true'))).toBe(
      canonicalJson({
        op: '&&',
        left: {
          op: '>',
          left: { op: '+', left: { int: 1 }, right: { op: '*', left: { int: 2 }, right: { int: 3 } } },
          right: { int: 4 },
        },
        right: { bool: true },
      }),
    )
  })

  it('|| 优先于最低层，且左结合', () => {
    expect(canonicalJson(ir('a || b && c'))).toBe(
      canonicalJson({ op: '||', left: { path: 'a' }, right: { op: '&&', left: { path: 'b' }, right: { path: 'c' } } }),
    )
  })

  it('括号改变结合', () => {
    expect(canonicalJson(ir('(1 + 2) * 3'))).toBe(
      canonicalJson({ op: '*', left: { op: '+', left: { int: 1 }, right: { int: 2 } }, right: { int: 3 } }),
    )
  })

  it('一元 ! 与 -', () => {
    expect(canonicalJson(ir('!true'))).toBe(canonicalJson({ op: 'not', arg: { bool: true } }))
    expect(canonicalJson(ir('-5'))).toBe(canonicalJson({ op: 'neg', arg: { int: 5 } }))
    expect(evaluateExpr(ir('-0'), {})).toBe(0)
  })

  it('比较不可连写', () => {
    const error = errorOf(() => parseExpression('1 < 2 < 3'))
    expect(error.code).toBe('policy-parse-error')
    expect(error.message).toContain('不可连写')
  })

  it('函数调用 / 环境读取一律拒绝', () => {
    expect(codeOf(() => parseExpression('matches(x)'))).toBe('policy-unknown-operator')
    expect(codeOf(() => parseExpression('now()'))).toBe('policy-unknown-operator')
    expect(codeOf(() => parseExpression('env.HOME'))).toBe('policy-unknown-field')
    expect(codeOf(() => parseExpression('process.pid'))).toBe('policy-unknown-field')
    expect(codeOf(() => parseExpression('env'))).toBe('policy-unknown-field')
    expect(codeOf(() => parseExpression('process'))).toBe('policy-unknown-field')
  })

  it('残缺表达式报解析错误', () => {
    expect(codeOf(() => parseExpression('(1'))).toBe('policy-parse-error')
    expect(codeOf(() => parseExpression('1 +'))).toBe('policy-parse-error')
    expect(codeOf(() => parseExpression('a.'))).toBe('policy-parse-error')
    expect(codeOf(() => parseExpression('1 2'))).toBe('policy-parse-error')
    expect(codeOf(() => parseExpression(''))).toBe('policy-parse-error')
  })

  it('嵌套深度上限 32', () => {
    const deep = `${'('.repeat(33)}true${')'.repeat(33)}`
    expect(codeOf(() => parseExpression(deep))).toBe('policy-limit-exceeded')
    const ok = `${'('.repeat(31)}true${')'.repeat(31)}`
    expect(check(ok).type).toBe('bool')
  })

  it('路径支持多级', () => {
    expect(canonicalJson(ir('preview.payee.binding'))).toBe(
      canonicalJson({ path: 'preview.payee.binding' }),
    )
  })

  it('toIr 覆盖所有节点；未知节点显式失败', () => {
    expect(canonicalJson(ir('"x"'))).toBe(canonicalJson({ str: 'x' }))
    expect(codeOf(() => toIr({ kind: 'nope' } as unknown as ExprNode))).toBe('policy-eval-invalid')
  })
})

describe('类型检查', () => {
  it('可选字段必须在 requires 内引用', () => {
    const error = errorOf(() => check('preview.amountCents > 0'))
    expect(error.code).toBe('policy-type-mismatch')
    expect(error.message).toContain('requires: [preview]')
    expect(check('preview.amountCents > 0', ['preview']).type).toBe('bool')
  })

  it('未知字段 / 对象前缀 / 未知参数', () => {
    expect(codeOf(() => check('preview.amount > 0', ['preview']))).toBe('policy-unknown-field')
    expect(codeOf(() => check('preview > 0', ['preview']))).toBe('policy-type-mismatch')
    expect(codeOf(() => check('params.unknown > 0'))).toBe('policy-unknown-param')
    expect(codeOf(() => check('params.a.b > 0'))).toBe('policy-unknown-param')
    expect(codeOf(() => check('params > 0'))).toBe('policy-unknown-field')
    expect(check('params.riskyCallThreshold >= 3').type).toBe('bool')
  })

  it('算术/比较/逻辑只接受对应类型', () => {
    expect(codeOf(() => check('1 + "a" > 0'))).toBe('policy-type-mismatch')
    expect(codeOf(() => check('"a" < "b"'))).toBe('policy-type-mismatch')
    expect(codeOf(() => check('true && 1'))).toBe('policy-type-mismatch')
    expect(codeOf(() => check('1 || true'))).toBe('policy-type-mismatch')
    expect(codeOf(() => check('-true > 0'))).toBe('policy-type-mismatch')
    expect(check('-state.riskyCallsInTurn > 0').type).toBe('bool')
    expect(check('-5 < 0').type).toBe('bool')
    expect(codeOf(() => check('!1'))).toBe('policy-type-mismatch')
  })

  it('when 必须是 bool', () => {
    const error = errorOf(() => check('1 + 1'))
    expect(error.code).toBe('policy-type-mismatch')
    expect(error.message).toContain('when 必须是 bool')
  })

  it('枚举只能与自身集合或成员字面量比较', () => {
    expect(check('preview.payee.binding == "new"', ['preview']).type).toBe('bool')
    expect(check('"new" == preview.payee.binding', ['preview']).type).toBe('bool')
    expect(codeOf(() => check('preview.payee.binding == "other"', ['preview']))).toBe(
      'policy-type-mismatch',
    )
    expect(codeOf(() => check('level == reason' ))).toBe('policy-type-mismatch')
  })

  it('int/string/bool 字段能读出正确类型', () => {
    expect(check('state.riskyCallsInTurn > 0').type).toBe('bool')
    expect(check('action.name == "x"').type).toBe('bool')
    expect(check('state.verifyLocked').type).toBe('bool')
    expect(check('level == "green"').type).toBe('bool')
    expect(check('reason == "declared"').type).toBe('bool')
    expect(check('limits.dailyLimitCents >= 0').type).toBe('bool')
  })

  it('describeType 覆盖全部形态（含不可达兜底）', () => {
    expect(describeType({ type: 'int', literal: 3 })).toBe('int(3)')
    expect(describeType({ type: 'int' })).toBe('int')
    expect(describeType({ type: 'bool' })).toBe('bool')
    expect(describeType({ type: 'string', literal: 'a' })).toBe('string("a")')
    expect(describeType({ type: 'string' })).toBe('string')
    expect(describeType({ type: 'enum', values: ['a', 'b'] })).toBe('enum(a|b)')
    expect(codeOf(() => describeType({ type: 'nope' } as unknown as ExprTypeInfo))).toBe(
      'policy-eval-invalid',
    )
  })

  it('未知节点/未知运算符在类型层显式失败', () => {
    const ctx = { params: PARAMS, requires: new Set<string>() }
    expect(codeOf(() => typeOf({ kind: 'nope' } as unknown as ExprNode, ctx))).toBe(
      'policy-eval-invalid',
    )
    expect(
      codeOf(() =>
        typeOf(
          {
            kind: 'binary',
            op: 'xor',
            left: { kind: 'bool', value: true, at: 0 },
            right: { kind: 'bool', value: true, at: 0 },
            at: 0,
          } as unknown as ExprNode,
          ctx,
        ),
      ),
    ).toBe('policy-eval-invalid')
  })
})

describe('求值', () => {
  it('金额边界：sum > limit 为真', () => {
    expect(
      evaluateExpr(ir('preview.dailyUsedCents + preview.amountCents > limits.dailyLimitCents'), SCOPE),
    ).toBe(true)
    const atLimit: EvalScope = {
      ...SCOPE,
      preview: { amountCents: 200_000, dailyUsedCents: 300_000, dailyLimitCents: 500_000, payee: { binding: 'whitelist' } },
    }
    expect(
      evaluateExpr(ir('preview.dailyUsedCents + preview.amountCents > limits.dailyLimitCents'), atLimit),
    ).toBe(false)
  })

  it('相等/不等/四则/比较', () => {
    expect(evaluateExpr(ir('1 == 1'), SCOPE)).toBe(true)
    expect(evaluateExpr(ir('1 != 2'), SCOPE)).toBe(true)
    expect(evaluateExpr(ir('1 + 2 * 3 - 4'), SCOPE)).toBe(3)
    expect(evaluateExpr(ir('2 < 3'), SCOPE)).toBe(true)
    expect(evaluateExpr(ir('2 <= 2'), SCOPE)).toBe(true)
    expect(evaluateExpr(ir('3 > 2'), SCOPE)).toBe(true)
    expect(evaluateExpr(ir('3 >= 3'), SCOPE)).toBe(true)
    expect(evaluateExpr(ir('"a" == "a"'), SCOPE)).toBe(true)
    expect(evaluateExpr(ir('true == false'), SCOPE)).toBe(false)
    expect(evaluateExpr(ir('true && false'), SCOPE)).toBe(false)
    expect(evaluateExpr(ir('false || true'), SCOPE)).toBe(true)
  })

  it('逻辑短路：右侧不执行也不会报错', () => {
    expect(evaluateExpr(ir('false && "not-bool"'), SCOPE)).toBe(false)
    expect(evaluateExpr(ir('true || "not-bool"'), SCOPE)).toBe(true)
    expect(codeOf(() => evaluateExpr(ir('true && "not-bool"'), SCOPE))).toBe('policy-eval-invalid')
    expect(codeOf(() => evaluateExpr(ir('false || "not-bool"'), SCOPE))).toBe('policy-eval-invalid')
    expect(codeOf(() => evaluateExpr(ir('1 && true'), SCOPE))).toBe('policy-eval-invalid')
    expect(codeOf(() => evaluateExpr(ir('1 || true'), SCOPE))).toBe('policy-eval-invalid')
  })

  it('一元运算的类型检查在运行期也成立（防坏 IR）', () => {
    expect(codeOf(() => evaluateExpr(ir('!"a"'), SCOPE))).toBe('policy-eval-invalid')
    expect(codeOf(() => evaluateExpr(ir('-"a"'), SCOPE))).toBe('policy-eval-invalid')
    expect(evaluateExpr(ir('-5'), SCOPE)).toBe(-5)
    expect(evaluateExpr(ir('!true'), SCOPE)).toBe(false)
  })

  it('整数溢出显式失败（加/减/乘）', () => {
    expect(codeOf(() => evaluateExpr({ op: '+', left: { int: Number.MAX_SAFE_INTEGER }, right: { int: 1 } }, SCOPE))).toBe(
      'policy-eval-overflow',
    )
    expect(
      codeOf(() => evaluateExpr({ op: '-', left: { int: Number.MIN_SAFE_INTEGER }, right: { int: 1 } }, SCOPE)),
    ).toBe('policy-eval-overflow')
    expect(
      codeOf(() => evaluateExpr({ op: '*', left: { int: 4_000_000_000 }, right: { int: 4_000_000_000 } }, SCOPE)),
    ).toBe('policy-eval-overflow')
  })

  it('路径缺失/中间节点非对象/末端非标量都是 IR 损坏', () => {
    expect(codeOf(() => evaluateExpr(ir('nope.x'), SCOPE))).toBe('policy-eval-invalid')
    expect(codeOf(() => evaluateExpr(ir('subject.userId.x'), SCOPE))).toBe('policy-eval-invalid')
    expect(codeOf(() => evaluateExpr(ir('subject'), SCOPE))).toBe('policy-eval-invalid')
  })

  it('比较运算符的操作数必须是整数', () => {
    expect(codeOf(() => evaluateExpr(ir('"a" < "b"'), SCOPE))).toBe('policy-eval-invalid')
    expect(codeOf(() => evaluateExpr(ir('1 < "b"'), SCOPE))).toBe('policy-eval-invalid')
  })

  it('未知运算符显式失败', () => {
    const bad = { op: 'xor', left: { int: 1 }, right: { int: 2 } } as unknown as IrExpr
    expect(codeOf(() => evaluateExpr(bad, SCOPE))).toBe('policy-eval-invalid')
  })

  it('条件求值必须是 bool', () => {
    expect(evaluateCondition(ir('true'), SCOPE)).toBe(true)
    expect(codeOf(() => evaluateCondition(ir('1'), SCOPE))).toBe('policy-eval-invalid')
  })

  it('kindOf 能识别全部六种 IR 节点', () => {
    expect(kindOf({ int: 1 })).toBe('int')
    expect(kindOf({ str: 'a' })).toBe('str')
    expect(kindOf({ bool: true })).toBe('bool')
    expect(kindOf({ path: 'a' })).toBe('path')
    expect(kindOf({ op: 'not', arg: { bool: true } })).toBe('unary')
    expect(kindOf({ op: '+', left: { int: 1 }, right: { int: 2 } })).toBe('binary')
  })
})
