/**
 * 表达式类型检查（施工方案 01 §5.2）。
 *
 * 类型规则只有一张表，但有一条**容易漏的口径**：可选字段（`preview.*`）不是
 * "读出来可能是 undefined"，而是**根本不允许在未守卫的表里读**。v1 没有 `has()`，
 * 守卫只有表级 `requires`——所以在没有 `requires: [preview]` 的表里写
 * `preview.amountCents` 是类型错误，而不是"运行时再说"。
 *
 * 错误里的 `column` 是**表达式内 1 基偏移**，由 `compile.ts` 映射成 YAML 行号。
 */

import { policyError } from '../errors.ts'
import { fieldOf, isObjectPrefix, type ParamSpec } from '../schema.ts'

import type { ExprNode } from './parser.ts'

/** 表达式类型（枚举与字符串在 `==` 上可互比，但仍是两种类型）。 */
export type ExprType = 'int' | 'bool' | 'string' | 'enum'

/** 类型检查上下文。 */
export interface CheckContext {
  /** bundle 声明的参数（名字 → 边界）。 */
  readonly params: Readonly<Record<string, ParamSpec>>
  /** 当前表的 `requires`（可选子树根）。 */
  readonly requires: ReadonlySet<string>
}

/** 一个节点的类型事实（能静态知道的都带上，供静态分析复用）。 */
export interface ExprTypeInfo {
  readonly type: ExprType
  /** 字面量的值（`==` 的枚举成员检查需要）。 */
  readonly literal?: number | string | boolean
  readonly min?: number
  readonly max?: number
  readonly values?: readonly string[]
  /** 路径节点才有。 */
  readonly path?: string
}

/** 类型的中文描述（错误信息用）。 */
export function describeType(info: ExprTypeInfo): string {
  switch (info.type) {
    case 'int':
      return info.literal === undefined ? 'int' : `int(${String(info.literal)})`
    case 'bool':
      return 'bool'
    case 'string':
      return info.literal === undefined ? 'string' : `string("${String(info.literal)}")`
    case 'enum':
      return `enum(${(info.values ?? []).join('|')})`
    default:
      return assertNeverType(info.type)
  }
}

/** 类型检查一个表达式（返回根类型）。 */
export function typeOf(node: ExprNode, ctx: CheckContext): ExprTypeInfo {
  switch (node.kind) {
    case 'int':
      return { type: 'int', literal: node.value, min: node.value, max: node.value }
    case 'string':
      return { type: 'string', literal: node.value }
    case 'bool':
      return { type: 'bool', literal: node.value }
    case 'path':
      return typeOfPath(node.path, node.at, ctx)
    case 'unary':
      return typeOfUnary(node, ctx)
    case 'binary':
      return typeOfBinary(node, ctx)
    default:
      return assertNeverNode(node)
  }
}

/** `when` 必须是 bool。 */
export function checkCondition(node: ExprNode, ctx: CheckContext): ExprTypeInfo {
  const info = typeOf(node, ctx)
  if (info.type !== 'bool') {
    throw policyError('policy-type-mismatch', `when 必须是 bool，实际 ${describeType(info)}`, {
      column: node.at + 1,
      expected: 'bool',
      actual: describeType(info),
    })
  }
  return info
}

function typeOfPath(path: string, at: number, ctx: CheckContext): ExprTypeInfo {
  if (path.startsWith('params.')) {
    const name = path.slice('params.'.length)
    const spec = ctx.params[name]
    if (spec === undefined || name.includes('.')) {
      throw policyError('policy-unknown-param', `参数 \`${name}\` 未在 manifest 声明`, {
        column: at + 1,
        name,
        path,
      })
    }
    return { type: 'int', min: spec.min, max: spec.max, path }
  }

  const field = fieldOf(path)
  if (field === undefined) {
    if (isObjectPrefix(path)) {
      throw policyError('policy-type-mismatch', `\`${path}\` 是对象，不能直接参与运算`, {
        column: at + 1,
        expected: 'scalar',
        actual: path,
      })
    }
    throw policyError('policy-unknown-field', `字段 \`${path}\` 不在 schema 内`, {
      column: at + 1,
      path,
    })
  }

  if (field.optionalRoot !== undefined && !ctx.requires.has(field.optionalRoot)) {
    throw policyError(
      'policy-type-mismatch',
      `可选字段 \`${path}\` 必须在表级 requires: [${field.optionalRoot}] 内引用`,
      {
        column: at + 1,
        expected: `requires:${field.optionalRoot}`,
        actual: path,
        path,
      },
    )
  }

  const declared = field.type
  if (declared.kind === 'int') return { type: 'int', min: declared.min, max: declared.max, path }
  if (declared.kind === 'string') return { type: 'string', path }
  if (declared.kind === 'bool') return { type: 'bool', path }
  return { type: 'enum', values: declared.values, path }
}

function typeOfUnary(node: Extract<ExprNode, { kind: 'unary' }>, ctx: CheckContext): ExprTypeInfo {
  const arg = typeOf(node.arg, ctx)
  if (node.op === '-') {
    requireType(arg, 'int', node.at, '一元负号')
    return arg.literal === undefined
      ? { type: 'int' }
      : { type: 'int', literal: -Number(arg.literal), min: -Number(arg.literal), max: -Number(arg.literal) }
  }
  requireType(arg, 'bool', node.at, '`!`')
  return { type: 'bool' }
}

function typeOfBinary(
  node: Extract<ExprNode, { kind: 'binary' }>,
  ctx: CheckContext,
): ExprTypeInfo {
  const left = typeOf(node.left, ctx)
  const right = typeOf(node.right, ctx)

  switch (node.op) {
    case '+':
    case '-':
    case '*':
      requireType(left, 'int', node.at, `\`${node.op}\` 左侧`)
      requireType(right, 'int', node.at, `\`${node.op}\` 右侧`)
      return { type: 'int' }
    case '<':
    case '<=':
    case '>':
    case '>=':
      requireType(left, 'int', node.at, `\`${node.op}\` 左侧`)
      requireType(right, 'int', node.at, `\`${node.op}\` 右侧`)
      return { type: 'bool' }
    case '==':
    case '!=':
      requireComparable(left, right, node.at, node.op)
      return { type: 'bool' }
    case '&&':
    case '||':
      requireType(left, 'bool', node.at, `\`${node.op}\` 左侧`)
      requireType(right, 'bool', node.at, `\`${node.op}\` 右侧`)
      return { type: 'bool' }
    default:
      return assertNeverOp(node.op)
  }
}

/** `==` / `!=` 的类型规则：同类型；枚举只能与同集合枚举或成员字面量比。 */
function requireComparable(
  left: ExprTypeInfo,
  right: ExprTypeInfo,
  at: number,
  op: string,
): void {
  if (left.type === 'enum' && right.type === 'string' && right.literal !== undefined) {
    requireMember(left, String(right.literal), at, op)
    return
  }
  if (right.type === 'enum' && left.type === 'string' && left.literal !== undefined) {
    requireMember(right, String(left.literal), at, op)
    return
  }
  if (left.type === right.type && left.type !== 'enum') return
  if (left.type === 'enum' && right.type === 'enum' && sameValues(left.values, right.values)) return

  throw policyError(
    'policy-type-mismatch',
    `\`${op}\` 两侧类型不同：${describeType(left)} 与 ${describeType(right)}`,
    { column: at + 1, expected: describeType(left), actual: describeType(right) },
  )
}

function requireMember(info: ExprTypeInfo, value: string, at: number, op: string): void {
  if ((info.values ?? []).includes(value)) return
  throw policyError(
    'policy-type-mismatch',
    `\`${op}\` 的字面量 "${value}" 不是 ${(info.values ?? []).join('|')} 的成员`,
    {
      column: at + 1,
      expected: (info.values ?? []).join('|'),
      actual: value,
    },
  )
}

function sameValues(left?: readonly string[], right?: readonly string[]): boolean {
  if (left === undefined || right === undefined) return false
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function requireType(info: ExprTypeInfo, type: ExprType, at: number, where: string): void {
  if (info.type === type) return
  throw policyError(
    'policy-type-mismatch',
    `${where} 必须是 ${type}，实际 ${describeType(info)}`,
    { column: at + 1, expected: type, actual: describeType(info) },
  )
}

function assertNeverType(type: never): never {
  throw policyError('policy-eval-invalid', `未处理的表达式类型：${String(type)}`)
}

function assertNeverNode(node: never): never {
  const value = node as { kind?: string }
  throw policyError('policy-eval-invalid', `未处理的表达式节点：${String(value.kind)}`)
}

function assertNeverOp(op: never): never {
  throw policyError('policy-eval-invalid', `未处理的运算符：${String(op)}`)
}
