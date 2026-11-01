/**
 * 表达式求值（设计方案 01 §5.4）。
 *
 * 求值对象是 **IR**（`IrExpr`），不是解析器 AST：IR 是唯一可执行形态，
 * 这样"审计里记录的表达式"和"实际算的表达式"结构上是同一份数据。
 *
 * 求值器是**纯函数**：没有时钟、随机、I/O、环境变量；同一输入两次结果必然全等。
 * 这里唯一的"防御"是坏的 IR（被篡改的 bundle 产物）：一律抛 `policy-eval-invalid`
 * 或 `policy-eval-overflow`，由治理平面 fail-closed，绝不返回 `allow`。
 */

import { policyError } from '../errors.ts'

import type { BinaryOp, IrExpr } from './parser.ts'

/** 求值作用域：输入对象 + `level`/`reason` 上下文，展平在同一层。 */
export type EvalScope = Readonly<Record<string, unknown>>

/** 标量值（表达式只可能算出这三种）。 */
export type ExprValue = boolean | number | string

/**
 * 求值一条 IR 表达式。
 *
 * @throws `policy-eval-invalid` 路径缺失/类型混乱（IR 与输入不匹配）
 * @throws `policy-eval-overflow` 整数运算超出安全整数范围
 */
export function evaluateExpr(node: IrExpr, scope: EvalScope): ExprValue {
  // 用 `in` 收窄而不是 switch：IR 的标签就是"存在的键"，没有第六种形态可落到 default。
  if ('int' in node) return node.int
  if ('str' in node) return node.str
  if ('bool' in node) return node.bool
  if ('path' in node) return readPath(scope, node.path)
  if ('arg' in node) return evaluateUnary(node, scope)
  return evaluateBinary(node, scope)
}

/** 求值一个条件（`when`）；非 bool 即 IR 损坏。 */
export function evaluateCondition(node: IrExpr, scope: EvalScope): boolean {
  const value = evaluateExpr(node, scope)
  if (typeof value !== 'boolean') {
    throw policyError('policy-eval-invalid', 'when 求值结果不是 bool', {
      expected: 'bool',
      actual: typeof value,
    })
  }
  return value
}

/** IR 节点的判别标签（IR 用"存在的键"作标签，与 §6.2 的形态一致）。 */
export type IrKind = 'int' | 'str' | 'bool' | 'path' | 'unary' | 'binary'

/** 取节点的判别标签。 */
export function kindOf(node: IrExpr): IrKind {
  if ('int' in node) return 'int'
  if ('str' in node) return 'str'
  if ('bool' in node) return 'bool'
  if ('path' in node) return 'path'
  if ('arg' in node) return 'unary'
  return 'binary'
}

function evaluateUnary(
  node: { op: 'not' | 'neg'; arg: IrExpr },
  scope: EvalScope,
): ExprValue {
  const value = evaluateExpr(node.arg, scope)
  if (node.op === 'not') {
    if (typeof value !== 'boolean') throw badOperand('!', 'bool', value)
    return !value
  }
  if (typeof value !== 'number') throw badOperand('-', 'int', value)
  return value === 0 ? 0 : -value
}

function evaluateBinary(
  node: { op: BinaryOp; left: IrExpr; right: IrExpr },
  scope: EvalScope,
): ExprValue {
  if (node.op === '&&') {
    const left = evaluateExpr(node.left, scope)
    if (typeof left !== 'boolean') throw badOperand('&&', 'bool', left)
    return left ? evaluateBool(node.right, scope, '&&') : false
  }
  if (node.op === '||') {
    const left = evaluateExpr(node.left, scope)
    if (typeof left !== 'boolean') throw badOperand('||', 'bool', left)
    return left ? true : evaluateBool(node.right, scope, '||')
  }

  const left = evaluateExpr(node.left, scope)
  const right = evaluateExpr(node.right, scope)
  if (node.op === '==') return left === right
  if (node.op === '!=') return left !== right
  if (node.op === '+') return arithmetic('+', left, right)
  if (node.op === '-') return arithmetic('-', left, right)
  if (node.op === '*') return arithmetic('*', left, right)
  return compare(node.op, left, right)
}

function evaluateBool(node: IrExpr, scope: EvalScope, op: string): boolean {
  const value = evaluateExpr(node, scope)
  if (typeof value !== 'boolean') throw badOperand(op, 'bool', value)
  return value
}

function arithmetic(op: '+' | '-' | '*', left: ExprValue, right: ExprValue): number {
  if (typeof left !== 'number') throw badOperand(op, 'int', left)
  if (typeof right !== 'number') throw badOperand(op, 'int', right)
  const result = op === '+' ? left + right : op === '-' ? left - right : left * right
  if (!Number.isSafeInteger(result)) {
    throw policyError(
      'policy-eval-overflow',
      `整数运算溢出：${String(left)} ${op} ${String(right)}`,
      { actual: result },
    )
  }
  return result
}

function compare(op: '<' | '<=' | '>' | '>=', left: ExprValue, right: ExprValue): boolean {
  if (typeof left !== 'number') throw badOperand(op, 'int', left)
  if (typeof right !== 'number') throw badOperand(op, 'int', right)
  switch (op) {
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    case '>=':
      return left >= right
    default:
      return assertNeverOp(op)
  }
}

/** 读点分路径；中间节点缺失即 IR 损坏（不是"业务字段为空"）。 */
function readPath(scope: EvalScope, path: string): ExprValue {
  const parts = path.split('.')
  let current: unknown = scope
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) throw missingPath(path, part)
    const record = current as Record<string, unknown>
    if (!(part in record)) throw missingPath(path, part)
    current = record[part]
  }
  if (typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') {
    return current
  }
  throw missingPath(path, parts[parts.length - 1] ?? path)
}

function missingPath(path: string, part: string): Error {
  return policyError('policy-eval-invalid', `路径 \`${path}\` 在输入中不可读（缺 \`${part}\`）`, {
    path,
    name: part,
  })
}

function badOperand(op: string, expected: 'bool' | 'int', actual: ExprValue): Error {
  return policyError('policy-eval-invalid', `\`${op}\` 的操作数必须是 ${expected}，实际 ${typeof actual}`, {
    expected,
    actual: typeof actual,
  })
}

function assertNeverOp(op: never): never {
  throw policyError('policy-eval-invalid', `未处理的运算符：${String(op)}`)
}
