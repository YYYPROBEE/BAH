/**
 * 沙箱受限表达式语言。
 *
 * 为什么语言属主在这里：模型生成的程序文本只能在**安全平面**定义的语言里跑，
 * 工具面（`@bah/bank`）只负责把调用交给沙箱。语言留在业务包里会让"谁能执行模型代码"
 * 这件事没有单一属主。
 *
 * 三条硬约束（本文件的存在理由）：
 * 1. **零依赖**：本文件不许 import 任何东西（连 `@bah/util` 也不行）——它会被
 *    `worker_threads` 直接加载，任何包名 import 都要经过 `dist/`，破坏"源码即可运行"；
 * 2. **可擦除语法**：只用 Node 的类型擦除能吃的语法（无 enum、无参数属性、无命名空间）；
 * 3. **无循环、无 IO 原语**：语言里根本没有 `while` / `for` / 函数定义 / 模块访问，
 *    所以"程序能跑多久"由运算数预算 + 墙钟双保险决定，而不是靠外部杀进程兜底。
 *
 * 支持的构造：数字、`+ - * / %`、括号、一元正负、`data.<path>` / `data['key']` 只读引用、
 * `sum / avg / min / max / round / abs` 六个纯函数、常量 `PI` / `E`。
 */

/** 程序级失败码（沙箱运行时把它们映射成 `sandbox/*` 上报）。 */
export type ProgramErrorCode =
  | 'program-invalid'
  | 'program-data-missing'
  | 'program-limit'
  | 'program-timeout'
  | 'program-result-invalid'

/** 程序级错误：带码、不带包前缀（前缀由调用方按自己的平面加）。 */
export class ProgramError extends Error {
  readonly code: ProgramErrorCode

  constructor(code: ProgramErrorCode, message: string) {
    super(message)
    this.name = 'ProgramError'
    this.code = code
  }
}

/**
 * 封闭联合的收尾断言（**本文件为什么自带一份**：见上方第 1 条硬约束"零依赖"）。
 *
 * `@bah/util` 的同名函数语义一致，但 worker 加载链上的文件不能走包名导入——
 * 这里抛 `ProgramError`，让未识别的 AST 节点变成可上报的 `program-invalid`，
 * 而不是静默算出一个 NaN 让业务层去猜。
 */
function assertNever(value: never, context: string): never {
  throw new ProgramError('program-invalid', `${context}：未识别的取值 ${String(value)}`)
}

/** 一次程序执行的输入（worker 协议载荷，必须可结构化克隆）。 */
export interface ProgramRequest {
  readonly code: string
  readonly data?: Readonly<Record<string, unknown>>
  readonly limits: {
    readonly timeoutMs: number
    readonly maxOperations: number
  }
}

/** 程序产出。 */
export interface ProgramResult {
  readonly value: number
  readonly operations: number
}

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
    if (values.length === 0) throw new ProgramError('program-invalid', 'avg 至少需要一个参数')
    return values.reduce((total, value) => total + value, 0) / values.length
  },
  min: (values) => {
    if (values.length === 0) throw new ProgramError('program-invalid', 'min 至少需要一个参数')
    return Math.min(...values)
  },
  max: (values) => {
    if (values.length === 0) throw new ProgramError('program-invalid', 'max 至少需要一个参数')
    return Math.max(...values)
  },
  round: (values) => {
    if (values.length !== 1) throw new ProgramError('program-invalid', 'round 只接受一个参数')
    const value = values[0]
    if (value === undefined) throw new ProgramError('program-invalid', 'round 缺少参数')
    return Math.round(value)
  },
  abs: (values) => {
    if (values.length !== 1) throw new ProgramError('program-invalid', 'abs 只接受一个参数')
    const value = values[0]
    if (value === undefined) throw new ProgramError('program-invalid', 'abs 缺少参数')
    return Math.abs(value)
  },
}

/**
 * 执行一个受限程序。
 *
 * @throws `ProgramError`（`program-invalid` / `program-data-missing` / `program-limit` /
 *   `program-timeout` / `program-result-invalid`）
 */
export function runProgram(request: ProgramRequest): ProgramResult {
  if (request.code.length > MAX_CODE_LENGTH) {
    throw new ProgramError('program-invalid', `表达式过长（上限 ${String(MAX_CODE_LENGTH)} 字符）`)
  }
  const parser = new Parser()
  const ast = parser.parse(tokenize(request.code))
  const evaluator = new Evaluator(
    request.data ?? {},
    request.limits.maxOperations,
    Date.now() + request.limits.timeoutMs,
  )
  const value = evaluator.evaluate(ast)
  if (!Number.isFinite(value)) {
    throw new ProgramError('program-result-invalid', `计算结果不是有限数字（${String(value)}）`)
  }
  return { value, operations: evaluator.operations }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Tokenizer
 * ──────────────────────────────────────────────────────────────────────────── */

function tokenize(code: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < code.length) {
    const char = code[index]
    if (char === undefined) break
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (/\d/.test(char) || (char === '.' && /\d/.test(code[index + 1] ?? ''))) {
      const matched = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(code.slice(index))
      if (matched === null) throw new ProgramError('program-invalid', `非法数字（位置 ${String(index)}）`)
      tokens.push({ kind: 'number', value: Number(matched[0]) })
      index += matched[0].length
      continue
    }
    if (char === "'" || char === '"') {
      const end = code.indexOf(char, index + 1)
      if (end < 0) throw new ProgramError('program-invalid', `字符串没有闭合（位置 ${String(index)}）`)
      const raw = code.slice(index + 1, end)
      tokens.push({ kind: 'string', value: raw.replace(/\\(['"\\])/g, '$1') })
      index = end + 1
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const matched = /^[A-Za-z_$][\w$]*/.exec(code.slice(index))
      if (matched === null) throw new ProgramError('program-invalid', `非法标识符（位置 ${String(index)}）`)
      tokens.push({ kind: 'ident', value: matched[0] })
      index += matched[0].length
      continue
    }
    if ('+-*/%(),.[]'.includes(char)) {
      tokens.push({ kind: 'op', value: char })
      index += 1
      continue
    }
    throw new ProgramError('program-invalid', `不支持的字符 ${JSON.stringify(char)}（位置 ${String(index)}）`)
  }
  tokens.push({ kind: 'eof' })
  return tokens
}

/* ────────────────────────────────────────────────────────────────────────────
 * Parser（递归下降）
 * ──────────────────────────────────────────────────────────────────────────── */

class Parser {
  private tokens: readonly Token[] = []
  private index = 0

  parse(tokens: readonly Token[]): Node {
    this.tokens = tokens
    this.index = 0
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
      throw new ProgramError('program-invalid', `未知标识符 ${token.value}（数据请用 data.xxx）`)
    }
    if (this.peekOp('(')) {
      this.nextOp()
      const node = this.expression()
      this.expect(')')
      return node
    }
    throw new ProgramError('program-invalid', `表达式不完整（位置 ${String(this.index)}）`)
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
        if (token.kind !== 'ident') throw new ProgramError('program-invalid', 'data 后面必须是字段名')
        this.index += 1
        keys.push(token.value)
        continue
      }
      if (this.peekOp('[')) {
        this.nextOp()
        const token = this.current()
        if (token.kind === 'ident' || token.kind === 'string' || token.kind === 'number') {
          this.index += 1
          keys.push(token.value)
        } else {
          throw new ProgramError('program-invalid', 'data[...] 只接受字段名或数字下标')
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
    if (token.kind !== 'op') throw new ProgramError('program-invalid', '期望运算符')
    this.index += 1
    return token.value
  }

  private expect(kind: 'eof' | ')' | ']'): void {
    if (kind === 'eof') {
      if (this.current().kind !== 'eof') throw new ProgramError('program-invalid', '表达式有多余内容')
      return
    }
    if (!this.peekOp(kind)) throw new ProgramError('program-invalid', `缺少 ${kind}`)
    this.index += 1
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Evaluator
 * ──────────────────────────────────────────────────────────────────────────── */

class Evaluator {
  operations = 0

  private readonly data: Readonly<Record<string, unknown>>
  private readonly maxOperations: number
  private readonly deadline: number

  constructor(data: Readonly<Record<string, unknown>>, maxOperations: number, deadline: number) {
    this.data = data
    this.maxOperations = maxOperations
    this.deadline = deadline
  }

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
            if (right === 0) throw new ProgramError('program-invalid', '除数为 0')
            return left / right
          case '%':
            if (right === 0) throw new ProgramError('program-invalid', '取模的除数为 0')
            return left % right
          default:
            throw new ProgramError('program-invalid', `未知运算符 ${node.op}`)
        }
      }
      case 'call': {
        const fn = FUNCTIONS[node.name]
        if (fn === undefined) {
          throw new ProgramError(
            'program-invalid',
            `未知函数 ${node.name}（可用：${Object.keys(FUNCTIONS).join(' / ')}）`,
          )
        }
        return fn(node.args.map((arg) => this.evaluate(arg)))
      }
      default:
        return assertNever(node, 'sandbox-lang-node')
    }
  }

  private readPath(keys: readonly (string | number)[]): number {
    let current: unknown = this.data
    for (const key of keys) {
      if (typeof current !== 'object' || current === null) {
        throw new ProgramError('program-data-missing', `数据路径 .${keys.join('.')} 不存在`)
      }
      current = (current as Record<string | number, unknown>)[key]
    }
    if (typeof current !== 'number' || !Number.isFinite(current)) {
      throw new ProgramError('program-data-missing', `数据路径 .${keys.join('.')} 不是有限数字`)
    }
    return current
  }

  private tick(): void {
    this.operations += 1
    if (this.operations > this.maxOperations) {
      throw new ProgramError('program-limit', `运算数超过预算 ${String(this.maxOperations)}`)
    }
    if (this.operations % DEADLINE_CHECK_EVERY === 0 && Date.now() > this.deadline) {
      throw new ProgramError('program-timeout', '表达式求值超时')
    }
  }
}
