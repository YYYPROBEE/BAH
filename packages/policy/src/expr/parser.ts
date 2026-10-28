/**
 * 表达式语法（施工方案 01 §5.1 的 EBNF）。
 *
 * 递归下降，优先级：`||` < `&&` < 比较 < 加减 < 乘 < 一元 < 原子。
 * 与方案 EBNF 的两处差异（已登记）：
 * 1. EBNF 的 `unary` 只写了 `-`，但 §5.2 类型表里有 `!`——实现按 §5.2 支持 `!`；
 * 2. 比较运算**不可连写**（`a < b < c` 报错），避免"看起来像数学、实际按优先级错算"。
 *
 * 解析器只产出 AST 与**偏移量**；`file:line:column` 的映射由 `compile.ts` 负责
 * （那里才知道这条表达式在 YAML 的哪一行）。
 */

import { policyError } from '../errors.ts'
import { POLICY_LIMITS } from '../limits.ts'

import { tokenize, type Token } from './lexer.ts'

/** 二元运算符。 */
export type BinaryOp = '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*'

/** 一元运算符。 */
export type UnaryOp = '!' | '-'

/** 表达式节点；`at` 是 0 基偏移。 */
export type ExprNode =
  | { readonly kind: 'int'; readonly value: number; readonly at: number }
  | { readonly kind: 'string'; readonly value: string; readonly at: number }
  | { readonly kind: 'bool'; readonly value: boolean; readonly at: number }
  | { readonly kind: 'path'; readonly path: string; readonly at: number }
  | { readonly kind: 'unary'; readonly op: UnaryOp; readonly arg: ExprNode; readonly at: number }
  | {
      readonly kind: 'binary'
      readonly op: BinaryOp
      readonly left: ExprNode
      readonly right: ExprNode
      readonly at: number
    }

/** 可执行形态（写进 IR；规范化的输入）。 */
export type IrExpr =
  | { readonly int: number }
  | { readonly str: string }
  | { readonly bool: boolean }
  | { readonly path: string }
  | { readonly op: 'not' | 'neg'; readonly arg: IrExpr }
  | {
      readonly op: BinaryOp
      readonly left: IrExpr
      readonly right: IrExpr
    }

const COMPARISONS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>='])

/**
 * 解析一条表达式。
 *
 * @throws `policy-parse-error` / `policy-unknown-operator` / `policy-limit-exceeded`
 */
export function parseExpression(source: string): ExprNode {
  return new Parser(tokenize(source)).parse()
}

/** 递归下降解析器。 */
class Parser {
  private index = 0

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): ExprNode {
    const node = this.parseOr()
    const rest = this.peek()
    if (rest.kind !== 'eof') {
      throw policyError('policy-parse-error', `表达式有多余内容 \`${rest.value}\``, {
        column: rest.at + 1,
      })
    }
    return node
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd()
    while (this.matchPunct('||')) {
      left = binary('||', left, this.parseAnd(), left.at)
    }
    return left
  }

  private parseAnd(): ExprNode {
    let left = this.parseComparison()
    while (this.matchPunct('&&')) {
      left = binary('&&', left, this.parseComparison(), left.at)
    }
    return left
  }

  private parseComparison(): ExprNode {
    const left = this.parseAdditive()
    const token = this.peek()
    if (token.kind !== 'punct' || !COMPARISONS.has(token.value)) return left

    this.index += 1
    const node = binary(token.value as BinaryOp, left, this.parseAdditive(), token.at)
    const next = this.peek()
    if (next.kind === 'punct' && COMPARISONS.has(next.value)) {
      throw policyError('policy-parse-error', '比较运算不可连写（请用 && 连接）', {
        column: next.at + 1,
      })
    }
    return node
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative()
    for (;;) {
      const token = this.peek()
      if (token.kind !== 'punct' || (token.value !== '+' && token.value !== '-')) return left
      this.index += 1
      left = binary(token.value, left, this.parseMultiplicative(), token.at)
    }
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary()
    for (;;) {
      const token = this.peek()
      if (token.kind !== 'punct' || token.value !== '*') return left
      this.index += 1
      left = binary('*', left, this.parseUnary(), token.at)
    }
  }

  private parseUnary(): ExprNode {
    const token = this.peek()
    if (token.kind === 'punct' && (token.value === '!' || token.value === '-')) {
      this.index += 1
      const arg = this.descend(() => this.parseUnary(), token)
      return { kind: 'unary', op: token.value, arg, at: token.at }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): ExprNode {
    const token = this.peek()

    if (token.kind === 'int') {
      this.index += 1
      return { kind: 'int', value: Number(token.value), at: token.at }
    }

    if (token.kind === 'string') {
      this.index += 1
      return { kind: 'string', value: token.value, at: token.at }
    }

    if (token.kind === 'punct' && token.value === '(') {
      this.index += 1
      const inner = this.descend(() => this.parseOr(), token)
      this.expectPunct(')')
      return inner
    }

    if (token.kind === 'ident') {
      return this.parseIdent()
    }

    throw policyError('policy-parse-error', `表达式在此处不完整：\`${token.value}\``, {
      column: token.at + 1,
    })
  }

  private parseIdent(): ExprNode {
    const token = this.peek()
    this.index += 1

    if (token.value === 'true' || token.value === 'false') {
      return { kind: 'bool', value: token.value === 'true', at: token.at }
    }

    const next = this.peek()
    if (next.kind === 'punct' && next.value === '(') {
      // `matches(...)` / `now()` / `random()` / `fetch(...)`：v1 没有函数调用。
      throw policyError('policy-unknown-operator', `不支持函数调用 \`${token.value}()\``, {
        column: next.at + 1,
        actual: token.value,
      })
    }
    if (token.value === 'env' || token.value === 'process') {
      throw policyError('policy-unknown-field', `不允许读环境/进程状态 \`${token.value}\``, {
        column: token.at + 1,
        path: token.value,
      })
    }

    let path = token.value
    while (this.peek().kind === 'punct' && this.peek().value === '.') {
      const dot = this.peek()
      this.index += 1
      const part = this.peek()
      if (part.kind !== 'ident') {
        throw policyError('policy-parse-error', '路径分隔符后必须是标识符', {
          column: dot.at + 1,
        })
      }
      this.index += 1
      path = `${path}.${part.value}`
    }
    return { kind: 'path', path, at: token.at }
  }

  /** 进入一层嵌套：超过深度上限即拒绝（括号/一元/逻辑嵌套都算）。 */
  private descend<T>(read: () => T, token: Token): T {
    this.depth += 1
    if (this.depth > POLICY_LIMITS.maxExprDepth) {
      throw policyError('policy-limit-exceeded', `表达式嵌套深度上限 ${String(POLICY_LIMITS.maxExprDepth)}`, {
        column: token.at + 1,
        limit: 'maxExprDepth',
        max: POLICY_LIMITS.maxExprDepth,
        size: this.depth,
      })
    }
    try {
      return read()
    } finally {
      this.depth -= 1
    }
  }

  private depth = 0

  private expectPunct(value: string): void {
    const token = this.peek()
    if (token.kind !== 'punct' || token.value !== value) {
      throw policyError('policy-parse-error', `缺少 \`${value}\``, { column: token.at + 1 })
    }
    this.index += 1
  }

  private matchPunct(value: string): boolean {
    const token = this.peek()
    if (token.kind !== 'punct' || token.value !== value) return false
    this.index += 1
    return true
  }

  private peek(): Token {
    const token = this.tokens[this.index]
    return token ?? (this.tokens[this.tokens.length - 1] as Token)
  }
}

/** 造一个二元节点（统一 `at` 取左操作数起点）。 */
function binary(op: BinaryOp, left: ExprNode, right: ExprNode, at: number): ExprNode {
  return { kind: 'binary', op, left, right, at }
}

/**
 * AST → 可执行 IR。
 *
 * 只保留语义字段：没有偏移、没有括号（括号已在树形里）；因此"重排 YAML 键序/缩进"
 * 不会改变 IR，也就不会改变语义摘要。
 */
export function toIr(node: ExprNode): IrExpr {
  switch (node.kind) {
    case 'int':
      return { int: node.value }
    case 'string':
      return { str: node.value }
    case 'bool':
      return { bool: node.value }
    case 'path':
      return { path: node.path }
    case 'unary':
      return { op: node.op === '!' ? 'not' : 'neg', arg: toIr(node.arg) }
    case 'binary':
      return { op: node.op, left: toIr(node.left), right: toIr(node.right) }
    default:
      return assertNeverNode(node)
  }
}

/** 封闭联合的收尾（AST 新增节点时编译期报错、运行期显式失败）。 */
function assertNeverNode(node: never): never {
  const value = node as { kind?: string }
  throw policyError('policy-eval-invalid', `未处理的表达式节点：${String(value.kind)}`)
}
