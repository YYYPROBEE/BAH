/**
 * 静态分析（设计方案 01 §7）。
 *
 * 目标不是"证明规则正确"，而是**在编译期杀掉可判定的坏规则**：
 * 重复谓词、被前序行完全覆盖、谓词恒假、参数声明了没用、deny 行排错位置。
 *
 * 值域抽象刻意保守（枚举集合 + 整数区间）：能证明不可满足才报错，证不出来就不报。
 * 全量符号执行/SMT 会引入求解器依赖，违背"零外部工具链"（G7），取舍写在 §7.3。
 */

import { canonicalJson } from '@bah/util'

import { policyError } from './errors.ts'
import { fieldOf, type ParamSpec } from './schema.ts'
import { kindOf } from './expr/eval.ts'
import type { BinaryOp, IrExpr } from './expr/parser.ts'
import type { ParsedTable, IrRow } from './table.ts'
import type { YamlSource } from './yaml.ts'

/** 分析上下文。 */
export interface AnalyzeContext {
  readonly source: YamlSource
  readonly params: Readonly<Record<string, ParamSpec>>
}

/** 非阻断告警（门禁可把它们升为错误）。 */
export interface PolicyWarning {
  readonly code: 'policy-deny-order'
  readonly message: string
  readonly table: string
  readonly line: number
}

const COMPARISONS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>='])

/**
 * 跑完全部静态检查。
 *
 * @throws `policy-unreachable-row` / `policy-unsatisfiable-row` / `policy-param-unused`
 * @returns 非阻断告警（目前只有 deny 顺序）
 */
export function analyzeTables(
  tables: readonly ParsedTable[],
  context: AnalyzeContext,
): PolicyWarning[] {
  const used = new Set<string>()
  for (const table of tables) {
    for (const row of table.rows) collectParams(row.when, used)

    for (const [index, row] of table.rows.entries()) {
      const previous = table.rows[index - 1]
      if (previous !== undefined && subsumes(previous, row)) {
        throw policyError(
          'policy-unreachable-row',
          `规则 \`${row.id}\` 被前序规则 \`${previous.id}\` 完全覆盖（永远不可能命中）`,
          {
            file: context.source.file,
            line: row.loc.line,
            column: row.loc.column,
            ruleId: row.id,
            table: table.id,
            by: previous.id,
          },
        )
      }
      if (isUnsatisfiable(row.when, context.params)) {
        throw policyError('policy-unsatisfiable-row', `规则 \`${row.id}\` 的谓词恒假`, {
          file: context.source.file,
          line: row.loc.line,
          column: row.loc.column,
          ruleId: row.id,
          table: table.id,
        })
      }
    }
  }

  for (const name of Object.keys(context.params)) {
    if (used.has(name)) continue
    throw policyError('policy-param-unused', `参数 \`${name}\` 已声明但没有任何行引用`, {
      file: context.source.file,
      name,
    })
  }

  return denyOrderWarnings(tables)
}

/** deny 行出现在 raise 表之后：可解释性变差（§4.3）。 */
function denyOrderWarnings(tables: readonly ParsedTable[]): PolicyWarning[] {
  const warnings: PolicyWarning[] = []
  let raiseSeen = false
  for (const table of tables) {
    const deny = table.rows.find((row) => row.action.kind === 'deny')
    if (deny !== undefined && raiseSeen) {
      warnings.push({
        code: 'policy-deny-order',
        message: `表 \`${table.id}\` 的 deny 行排在 raise 表之后（deny 是终态，应前置）`,
        table: table.id,
        line: deny.loc.line,
      })
    }
    if (table.rows.some((row) => row.action.kind === 'raise')) raiseSeen = true
  }
  return warnings
}

/** 收集表达式里引用的参数名。 */
function collectParams(node: IrExpr, into: Set<string>): void {
  const kind = kindOf(node)
  if (kind === 'path') {
    const path = (node as { path: string }).path
    if (path.startsWith('params.')) into.add(path.slice('params.'.length))
    return
  }
  if (kind === 'unary') {
    collectParams((node as { arg: IrExpr }).arg, into)
    return
  }
  if (kind === 'binary') {
    const binary = node as { left: IrExpr; right: IrExpr }
    collectParams(binary.left, into)
    collectParams(binary.right, into)
  }
}

/** 整数区间上的规范约束：上界 `<=`、下界 `>=`、等值、不等。 */
interface Bound {
  readonly path: string
  readonly dir: 'le' | 'ge' | 'eq' | 'ne'
  readonly value: number | string | boolean
}

/** 前一行是否**必然**覆盖后一行（整数区间 + 等值，保守但 sound）。 */
function subsumes(previous: IrRow, current: IrRow): boolean {
  if (canonicalJson(previous.when) === canonicalJson(current.when)) return true

  const left = asBound(previous.when)
  const right = asBound(current.when)
  if (left === undefined || right === undefined) return false
  if (left.path !== right.path) return false

  if (left.dir === 'eq' || right.dir === 'eq' || left.dir === 'ne' || right.dir === 'ne') {
    return left.dir === right.dir && left.value === right.value
  }

  const a = left.value
  const b = right.value
  if (typeof a !== 'number' || typeof b !== 'number') return false
  // 前一行是 `x <= a`，后一行是 `x <= b`：前者的集合更大 ⇔ a >= b。
  if (left.dir === 'le' && right.dir === 'le') return a >= b
  // 前一行是 `x >= a`，后一行是 `x >= b`：前者的集合更大 ⇔ a <= b。
  if (left.dir === 'ge' && right.dir === 'ge') return a <= b
  return false
}

/**
 * 把"路径 op 常量"（或镜像写法）抽成整数端点约束。
 *
 * 整数的严格比较先折算成非严格端点：`p < a` ≡ `p <= a-1`，`p > a` ≡ `p >= a+1`。
 * 不做这一步，"`< 5` 覆盖 `<= 4`" 这种显然的冗余就证不出来。
 */
function asBound(node: IrExpr): Bound | undefined {
  if (kindOf(node) !== 'binary') return undefined
  const binary = node as { op: BinaryOp; left: IrExpr; right: IrExpr }
  if (!COMPARISONS.has(binary.op)) return undefined

  const leftPath = pathOf(binary.left)
  const rightPath = pathOf(binary.right)
  const leftValue = literalOf(binary.left)
  const rightValue = literalOf(binary.right)

  if (leftPath !== undefined && rightValue !== undefined) {
    return toBound(leftPath, binary.op, rightValue)
  }
  if (rightPath !== undefined && leftValue !== undefined) {
    return toBound(rightPath, flip(binary.op), leftValue)
  }
  return undefined
}

/** 运算符 + 常量 → 规范端点（非数值只保留等值/不等）。 */
function toBound(path: string, op: BinaryOp, value: number | string | boolean): Bound | undefined {
  if (typeof value === 'number') {
    if (op === '<') return { path, dir: 'le', value: value - 1 }
    if (op === '<=') return { path, dir: 'le', value }
    if (op === '>') return { path, dir: 'ge', value: value + 1 }
    if (op === '>=') return { path, dir: 'ge', value }
  }
  if (op === '==') return { path, dir: 'eq', value }
  if (op === '!=') return { path, dir: 'ne', value }
  return undefined
}

function pathOf(node: IrExpr): string | undefined {
  return kindOf(node) === 'path' ? (node as { path: string }).path : undefined
}

function literalOf(node: IrExpr): number | string | boolean | undefined {
  const kind = kindOf(node)
  if (kind === 'int') return (node as { int: number }).int
  if (kind === 'str') return (node as { str: string }).str
  if (kind === 'bool') return (node as { bool: boolean }).bool
  if (kind === 'unary') {
    const unary = node as { op: 'not' | 'neg'; arg: IrExpr }
    if (unary.op === 'neg') {
      const inner = literalOf(unary.arg)
      return typeof inner === 'number' ? -inner : undefined
    }
  }
  return undefined
}

/** 镜像写法时把运算符翻转（`5 < p` ≡ `p > 5`）。 */
function flip(op: BinaryOp): BinaryOp {
  if (op === '<') return '>'
  if (op === '<=') return '>='
  if (op === '>') return '<'
  if (op === '>=') return '<='
  return op
}

/** 谓词是否在值域上恒假。 */
function isUnsatisfiable(node: IrExpr, params: Record<string, ParamSpec>): boolean {
  const kind = kindOf(node)

  if (kind === 'bool') return (node as { bool: boolean }).bool === false

  if (kind === 'unary') {
    const arg = (node as { arg: IrExpr }).arg
    return literalOf(arg) === true
  }

  if (kind !== 'binary') return false
  const binary = node as { op: BinaryOp; left: IrExpr; right: IrExpr }

  if (binary.op === '&&') {
    return isUnsatisfiable(binary.left, params) || isUnsatisfiable(binary.right, params)
  }
  if (binary.op === '||') {
    return isUnsatisfiable(binary.left, params) && isUnsatisfiable(binary.right, params)
  }

  const bound = asBound(node)
  if (bound === undefined) {
    // 纯常量表达式：算出来是 false 就恒假。
    if (hasPath(node)) return false
    return constantBoolean(node) === false
  }
  return violatesDomain(bound, params)
}

/** 表达式是否不含任何路径（可常量折叠）。 */
function hasPath(node: IrExpr): boolean {
  const kind = kindOf(node)
  if (kind === 'path') return true
  if (kind === 'unary') return hasPath((node as { arg: IrExpr }).arg)
  if (kind === 'binary') {
    const binary = node as { left: IrExpr; right: IrExpr }
    return hasPath(binary.left) || hasPath(binary.right)
  }
  return false
}

/** 常量表达式求值（只处理无路径的 bool 结果；其他返回 undefined）。 */
function constantBoolean(node: IrExpr): boolean | undefined {
  const value = constantValue(node)
  return typeof value === 'boolean' ? value : undefined
}

function constantValue(node: IrExpr): number | string | boolean | undefined {
  const kind = kindOf(node)
  if (kind === 'int') return (node as { int: number }).int
  if (kind === 'str') return (node as { str: string }).str
  if (kind === 'bool') return (node as { bool: boolean }).bool

  if (kind === 'unary') {
    const unary = node as { op: 'not' | 'neg'; arg: IrExpr }
    const value = constantValue(unary.arg)
    if (typeof value !== 'number' && typeof value !== 'boolean') return undefined
    if (unary.op === 'neg') return typeof value === 'number' ? -value : undefined
    return typeof value === 'boolean' ? !value : undefined
  }

  if (kind !== 'binary') return undefined
  const binary = node as { op: BinaryOp; left: IrExpr; right: IrExpr }
  const left = constantValue(binary.left)
  const right = constantValue(binary.right)
  if (left === undefined || right === undefined) return undefined

  switch (binary.op) {
    case '==':
      return left === right
    case '!=':
      return left !== right
    case '+':
      return typeof left === 'number' && typeof right === 'number' ? left + right : undefined
    case '-':
      return typeof left === 'number' && typeof right === 'number' ? left - right : undefined
    case '*':
      return typeof left === 'number' && typeof right === 'number' ? left * right : undefined
    case '<':
      return typeof left === 'number' && typeof right === 'number' ? left < right : undefined
    case '<=':
      return typeof left === 'number' && typeof right === 'number' ? left <= right : undefined
    case '>':
      return typeof left === 'number' && typeof right === 'number' ? left > right : undefined
    case '>=':
      return typeof left === 'number' && typeof right === 'number' ? left >= right : undefined
    case '&&':
      return typeof left === 'boolean' && typeof right === 'boolean' ? left && right : undefined
    case '||':
      return typeof left === 'boolean' && typeof right === 'boolean' ? left || right : undefined
    default:
      return undefined
  }
}

/** 端点是否与字段值域不相交。 */
function violatesDomain(bound: Bound, params: Record<string, ParamSpec>): boolean {
  const domain = domainOf(bound.path, params)
  if (domain === undefined) return false

  if (domain.kind === 'enum') {
    // v1 的枚举都 ≥2 个取值，`!= 成员` 永远可满足；只有 `== 非成员` 是恒假。
    if (bound.dir !== 'eq') return false
    return !domain.values.includes(String(bound.value))
  }

  if (typeof bound.value !== 'number') return false
  const value = bound.value
  if (bound.dir === 'le') return value < domain.min
  if (bound.dir === 'ge') return value > domain.max
  if (bound.dir === 'eq') return value < domain.min || value > domain.max
  return domain.min === domain.max && value === domain.min
}

/** 路径的值域（参数 > schema 字段；未知返回 undefined）。 */
function domainOf(
  path: string,
  params: Record<string, ParamSpec>,
):
  | { readonly kind: 'int'; readonly min: number; readonly max: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | undefined {
  if (path.startsWith('params.')) {
    const spec = params[path.slice('params.'.length)]
    return spec === undefined ? undefined : { kind: 'int', min: spec.min, max: spec.max }
  }
  const field = fieldOf(path)
  if (field === undefined) return undefined
  if (field.type.kind === 'int') return { kind: 'int', min: field.type.min, max: field.type.max }
  if (field.type.kind === 'enum') return { kind: 'enum', values: field.type.values }
  return undefined
}
