/**
 * 受限表达式求值器（施工单 08 §3.6 `analysis_calc` 的默认实现）。
 *
 * 为什么不是 `eval` / `new Function`：模型生成的代码**永不进 `none` 档**（施工单 11）。
 * 本文件只实现一个确定性的算术表达式语言：
 * - 数字、`+ - * / %`、括号、一元正负；
 * - `data.<path>` / `data['key']` 只读数据引用；
 * - `sum/avg/min/max/round/abs` 五个纯函数；
 * - 硬预算（运算数 + 墙钟），超限抛结构化 `compute-timeout` / `compute-limit`。
 *
 * 11 的沙箱插件落地后可以整体替换这个 seam；工具层仍保留 `Promise.race` 超时兜底。
 */

import { BahError } from '@bah/util'

import type { ComputeRequest, ComputeResult, ComputeSeam } from './types.ts'

/** 默认运算预算（与超时无关的确定性上限）。 */
export const DEFAULT_MAX_OPERATIONS = 10_000

/** 墙钟检查间隔（每 N 次求值检查一次）。 */
const DEADLINE_CHECK_EVERY = 256

/** 表达式最大长度（防止用超长字符串拖垮 tokenizer）。 */
const MAX_CODE_LENGTH = 2_000

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'ident'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'op'; readonly value: string }
  | { readonly kind: 'eof' }

type Node =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'path'; readonly keys: readonly (string | number)[] }
  | { readonly kind: 'unary'; readonly op: '+' | '-'; readonly operand: Node }
  | { readonly kind: 'binary'; readonly op: string; readonly left: Node; readonly right: Node }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly Node[] }

const FUNCTIONS: Readonly<Record<string, (values: readonly number[]) => number>> = {
  sum: (values) => values.reduce((total, value) => total + value, 0),
  avg: (values) => {
    if (values.length === 0) throw computeError('compute-invalid', 'avg 至少需要一个参数')
    return values.reduce((total, value) => total + value, 0) / values.length
  },
  min: (values) => {
    if (values.length === 0) throw computeError('compute-invalid', 'min 至少需要一个参数')
    return Math.min(...values)
  },
  max: (values) => {
    if (values.length === 0) throw computeError('compute-invalid', 'max 至少需要一个参数')
    return Math.max(...values)
  },
  round: (values) => {
    if (values.length !== 1) throw computeError('compute-invalid', 'round 只接受一个参数')
    return Math.round(values[0] as number)
  },
  abs: (values) => {
    if (values.length !== 1) throw computeError('compute-invalid', 'abs 只接受一个参数')
    return Math.abs(values[0] as number)
  },
}

/** 造一个结构化计算错误。 */
function computeError(code: string, message: string, detail?: unknown): BahError {
  return new BahError(code, `bank-tools: ${message}`, detail)
}

/**
 * 默认受限计算：同步求值，返回数值结果与运算数。
 *
 * @throws `BahError('compute-invalid' | 'compute-data-missing' | 'compute-limit' |
 *   'compute-timeout' | 'compute-result-invalid')`
 */
export function evaluateExpression(request: ComputeRequest): ComputeResult {
  if (request.code.length > MAX_CODE_LENGTH) {
    throw computeError('compute-invalid', `表达式过长（上限 ${MAX_CODE_LENGTH} 字符）`)
  }
  const deadline = Date.now() + request.limits.timeoutMs
  const parser = new Parser(tokenize(request.code))
  const ast = parser.parse()
  const evaluator = new Evaluator(request.data ?? {}, request.limits.maxOperations, deadline)
  const value = evaluator.evaluate(ast)
  if (!Number.isFinite(value)) {
    throw computeError('compute-result-invalid', `计算结果不是有限数字（${String(value)}）`)
  }
  return { value, operations: evaluator.operations }
}

/** 默认 seam（异步签名，便于 11 替换成真沙箱）。 */
export const defaultCompute: ComputeSeam = async (request) => evaluateExpression(request)

/* ────────────────────────────────────────────────────────────────────────────
 * Tokenizer
 * ──────────────────────────────────────────────────────────────────────────── */

function tokenize(code: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < code.length) {
    const char = code[index] as string
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (/\d/.test(char) || (char === '.' && /\d/.test(code[index + 1] ?? ''))) {
      const matched = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(code.slice(index))
      if (matched === null) throw computeError('compute-invalid', `非法数字（位置 ${index}）`)
      tokens.push({ kind: 'number', value: Number(matched[0]) })
      index += matched[0].length
      continue
    }
    if (char === "'" || char === '"') {
      const end = code.indexOf(char, index + 1)
      if (end < 0) throw computeError('compute-invalid', `字符串没有闭合（位置 ${index}）`)
      const raw = code.slice(index + 1, end)
      tokens.push({ kind: 'string', value: raw.replace(/\\(['"\\])/g, '$1') })
      index = end + 1
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const matched = /^[A-Za-z_$][\w$]*/.exec(code.slice(index))
      if (matched === null) throw computeError('compute-invalid', `非法标识符（位置 ${index}）`)
      tokens.push({ kind: 'ident', value: matched[0] })
      index += matched[0].length
      continue
    }
    if ('+-*/%(),.[]'.includes(char)) {
      tokens.push({ kind: 'op', value: char })
      index += 1
      continue
    }
    throw computeError('compute-invalid', `不支持的字符 ${JSON.stringify(char)}（位置 ${index}）`)
  }
  tokens.push({ kind: 'eof' })
  return tokens
}

/* ────────────────────────────────────────────────────────────────────────────
 * Parser（递归下降）
 * ──────────────────────────────────────────────────────────────────────────── */

class Parser {
  private index = 0

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): Node {
    const node = this.expression()
    this.expect('eof')
    return node
  }

  private expression(): Node {
    let left = this.term()
    while (this.peekOp('+') || this.peekOp('-')) {
      const op = this.nextOp()
      left = { kind: 'binary', op, left, right: this.term() }
    }
    return left
  }

  private term(): Node {
    let left = this.unary()
    while (this.peekOp('*') || this.peekOp('/') || this.peekOp('%')) {
      const op = this.nextOp()
      left = { kind: 'binary', op, left, right: this.unary() }
    }
    return left
  }

  private unary(): Node {
    if (this.peekOp('+') || this.peekOp('-')) {
      const op = this.nextOp() as '+' | '-'
      return { kind: 'unary', op, operand: this.unary() }
    }
    return this.primary()
  }

  private primary(): Node {
    const token = this.current()
    if (token.kind === 'number') {
      this.index += 1
      return { kind: 'number', value: token.value }
    }
    if (token.kind === 'ident') {
      this.index += 1
      if (this.peekOp('(')) {
        this.nextOp()
        const args = this.arguments()
        this.expect(')')
        return { kind: 'call', name: token.value, args }
      }
      if (token.value === 'data') return { kind: 'path', keys: this.path() }
      if (token.value === 'PI') return { kind: 'number', value: Math.PI }
      if (token.value === 'E') return { kind: 'number', value: Math.E }
      throw computeError('compute-invalid', `未知标识符 ${token.value}（数据请用 data.xxx）`)
    }
    if (this.peekOp('(')) {
      this.nextOp()
      const node = this.expression()
      this.expect(')')
      return node
    }
    throw computeError('compute-invalid', `表达式不完整（位置 ${this.index}）`)
  }

  private arguments(): Node[] {
    const args: Node[] = []
    if (this.peekOp(')')) return args
    args.push(this.expression())
    while (this.peekOp(',')) {
      this.nextOp()
      args.push(this.expression())
    }
    return args
  }

  /** `data` 之后的 `.key` / `['key']` / `[0]` 序列。 */
  private path(): (string | number)[] {
    const keys: (string | number)[] = []
    for (;;) {
      if (this.peekOp('.')) {
        this.nextOp()
        const token = this.current()
        if (token.kind !== 'ident') throw computeError('compute-invalid', 'data 后面必须是字段名')
        this.index += 1
        keys.push(token.value)
        continue
      }
      if (this.peekOp('[')) {
        this.nextOp()
        const token = this.current()
        if (token.kind === 'ident') {
          this.index += 1
          keys.push(token.value)
        } else if (token.kind === 'string') {
          this.index += 1
          keys.push(token.value)
        } else if (token.kind === 'number') {
          this.index += 1
          keys.push(token.value)
        } else {
          throw computeError('compute-invalid', 'data[...] 只接受字段名或数字下标')
        }
        this.expect(']')
        continue
      }
      return keys
    }
  }

  private current(): Token {
    return this.tokens[this.index] as Token
  }

  private peekOp(value: string): boolean {
    const token = this.current()
    return token.kind === 'op' && token.value === value
  }

  private nextOp(): string {
    const token = this.current()
    if (token.kind !== 'op') throw computeError('compute-invalid', '期望运算符')
    this.index += 1
    return token.value
  }

  private expect(kind: 'eof' | ')' | ']'): void {
    if (kind === 'eof') {
      if (this.current().kind !== 'eof') throw computeError('compute-invalid', '表达式有多余内容')
      return
    }
    if (!this.peekOp(kind)) throw computeError('compute-invalid', `缺少 ${kind}`)
    this.index += 1
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Evaluator
 * ──────────────────────────────────────────────────────────────────────────── */

class Evaluator {
  operations = 0

  constructor(
    private readonly data: Readonly<Record<string, unknown>>,
    private readonly maxOperations: number,
    private readonly deadline: number,
  ) {}

  evaluate(node: Node): number {
    this.tick()
    switch (node.kind) {
      case 'number':
        return node.value
      case 'path':
        return this.readPath(node.keys)
      case 'unary': {
        const value = this.evaluate(node.operand)
        return node.op === '-' ? -value : value
      }
      case 'binary': {
        const left = this.evaluate(node.left)
        const right = this.evaluate(node.right)
        switch (node.op) {
          case '+':
            return left + right
          case '-':
            return left - right
          case '*':
            return left * right
          case '/':
            if (right === 0) throw computeError('compute-invalid', '除数为 0')
            return left / right
          case '%':
            if (right === 0) throw computeError('compute-invalid', '取模的除数为 0')
            return left % right
          default:
            throw computeError('compute-invalid', `未知运算符 ${node.op}`)
        }
      }
      case 'call': {
        const fn = FUNCTIONS[node.name]
        if (fn === undefined) {
          throw computeError('compute-invalid', `未知函数 ${node.name}（可用：${Object.keys(FUNCTIONS).join(' / ')}）`)
        }
        return fn(node.args.map((arg) => this.evaluate(arg)))
      }
    }
  }

  private readPath(keys: readonly (string | number)[]): number {
    let current: unknown = this.data
    for (const key of keys) {
      if (typeof current !== 'object' || current === null) {
        throw computeError('compute-data-missing', `数据路径 .${keys.join('.')} 不存在`)
      }
      current = (current as Record<string | number, unknown>)[key]
    }
    if (typeof current !== 'number' || !Number.isFinite(current)) {
      throw computeError('compute-data-missing', `数据路径 .${keys.join('.')} 不是有限数字`, {
        path: keys,
      })
    }
    return current
  }

  private tick(): void {
    this.operations += 1
    if (this.operations > this.maxOperations) {
      throw computeError('compute-limit', `运算数超过预算 ${this.maxOperations}`)
    }
    if (this.operations % DEADLINE_CHECK_EVERY === 0 && Date.now() > this.deadline) {
      throw computeError('compute-timeout', '表达式求值超时')
    }
  }
}
