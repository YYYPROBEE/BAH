/**
 * 表达式词法（设计方案 01 §5.1）。
 *
 * 词法层就把"不该出现的语言特性"拦掉，而不是留给求值器：
 * - 没有小数点/科学计数 → 浮点金额在词法阶段失败；
 * - 没有正则字面量、没有 `~=`；
 * - 控制字符与超长字符串按 `policy-limit-exceeded` 拒绝（防注释注入型载荷）。
 */

import { policyError } from '../errors.ts'
import { POLICY_LIMITS } from '../limits.ts'

/** 词法单元类型。 */
export type TokenKind = 'int' | 'string' | 'ident' | 'punct' | 'eof'

/** 一个词法单元；`at` 是在源串里的 0 基偏移（用于错误列号）。 */
export interface Token {
  readonly kind: TokenKind
  readonly value: string
  readonly at: number
}

/** 多字符运算符（先长后短匹配）。 */
const PUNCTUATION = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '!', '(', ')', '.'] as const

const IDENT_START = /[A-Za-z_]/
const IDENT_PART = /[A-Za-z0-9_]/
const DIGIT = /[0-9]/

/**
 * 把表达式切成词法单元。
 *
 * @param source 表达式源码（YAML 标量的值）
 * @throws `policy-parse-error` 语法/字符错误；`policy-unknown-operator` 正则运算符；
 *   `policy-limit-exceeded` 超长或控制字符
 */
export function tokenize(source: string): Token[] {
  if (source.length > POLICY_LIMITS.maxExprChars) {
    throw policyError('policy-limit-exceeded', `表达式长度上限 ${String(POLICY_LIMITS.maxExprChars)}`, {
      limit: 'maxExprChars',
      max: POLICY_LIMITS.maxExprChars,
      size: source.length,
    })
  }

  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    const char = source[index] as string

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1
      continue
    }

    if ((char.codePointAt(0) ?? 0) < 0x20) {
      throw policyError('policy-limit-exceeded', '表达式含控制字符', {
        limit: 'control-character',
        size: index,
      })
    }

    if (char === '"') {
      const read = readString(source, index)
      tokens.push({ kind: 'string', value: read.value, at: index })
      index = read.next
      continue
    }

    if (DIGIT.test(char)) {
      const read = readInteger(source, index)
      tokens.push({ kind: 'int', value: read.value, at: index })
      index = read.next
      continue
    }

    if (IDENT_START.test(char)) {
      let end = index + 1
      while (end < source.length && IDENT_PART.test(source[end] as string)) end += 1
      tokens.push({ kind: 'ident', value: source.slice(index, end), at: index })
      index = end
      continue
    }

    if (char === '~') {
      throw policyError('policy-unknown-operator', '不支持正则/字符串匹配运算符 `~=`', {
        actual: '~=',
      })
    }

    const punct = PUNCTUATION.find((candidate) => source.startsWith(candidate, index))
    if (punct !== undefined) {
      tokens.push({ kind: 'punct', value: punct, at: index })
      index += punct.length
      continue
    }

    throw policyError('policy-parse-error', `无法识别的字符 \`${char}\``, {
      column: index + 1,
      actual: char,
    })
  }

  tokens.push({ kind: 'eof', value: '', at: source.length })
  return tokens
}

/** 读一个字符串字面量（含转义）。 */
function readString(source: string, start: number): { value: string; next: number } {
  let value = ''
  let index = start + 1

  while (index < source.length) {
    const char = source[index] as string
    if (char === '"') {
      if (value.length > POLICY_LIMITS.maxStringLength) {
        throw policyError('policy-limit-exceeded', '字符串字面量超长', {
          limit: 'maxStringLength',
          max: POLICY_LIMITS.maxStringLength,
          size: value.length,
        })
      }
      return { value, next: index + 1 }
    }
    if (char === '\\') {
      const read = readEscape(source, index)
      value += read.value
      index = read.next
      continue
    }
    value += char
    index += 1
  }

  throw policyError('policy-parse-error', '字符串字面量没有闭合', { column: start + 1 })
}

/** 读一个转义序列；只允许 `\"` `\\` `\n` `\t` `\uXXXX`。 */
function readEscape(source: string, start: number): { value: string; next: number } {
  const kind = source[start + 1]
  switch (kind) {
    case '"':
      return { value: '"', next: start + 2 }
    case '\\':
      return { value: '\\', next: start + 2 }
    case 'n':
      return { value: '\n', next: start + 2 }
    case 't':
      return { value: '\t', next: start + 2 }
    case 'u': {
      const hex = source.slice(start + 2, start + 6)
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
        throw policyError('policy-parse-error', '`\\u` 转义必须是 4 位十六进制', {
          column: start + 1,
        })
      }
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), next: start + 6 }
    }
    default:
      throw policyError('policy-parse-error', `不支持的转义 \`\\${String(kind)}\``, {
        column: start + 1,
      })
  }
}

/** 读一个十进制整数；拒绝前导零、小数、科学计数。 */
function readInteger(source: string, start: number): { value: string; next: number } {
  let end = start
  while (end < source.length && DIGIT.test(source[end] as string)) end += 1

  const text = source.slice(start, end)
  const after = source[end]

  if (after === '.') {
    throw policyError('policy-parse-error', '不支持小数（金额只用整数分）', {
      column: start + 1,
      actual: `${text}.`,
    })
  }
  if (after === 'e' || after === 'E') {
    throw policyError('policy-parse-error', '不支持科学计数法', {
      column: start + 1,
      actual: `${text}${after}`,
    })
  }
  if (text.length > 1 && text.startsWith('0')) {
    throw policyError('policy-parse-error', `整数字面量不允许前导零：\`${text}\``, {
      column: start + 1,
      actual: text,
    })
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) {
    throw policyError('policy-parse-error', `整数字面量超出安全范围：${text}`, {
      column: start + 1,
      actual: text,
    })
  }
  return { value: text, next: end }
}
