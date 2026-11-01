/**
 * YAML 读取与"路径 → 行号"定位（设计方案 01 §6.1 / §6.5）。
 *
 * 为什么不用 `YAML.parse`：它只给对象，不给行号；而本方案要求**任何**与规则有关的
 * 错误都能点到 `file:line`。`parseDocument` 保留每个节点的字节区间，配合
 * `LineCounter` 就能把任意 YAML 路径映射回行列。
 *
 * 严格性：重复键报错、别名禁用（`maxAliasCount: 0`）——bundle 不需要 YAML 高级特性，
 * 允许它们只会给"同一份文本两种展开"留下空间。
 */

import { LineCounter, parseDocument, type Document } from 'yaml'

import { policyError } from './errors.ts'

/** 一份已解析的 YAML 及其行号索引。 */
export interface YamlSource {
  readonly doc: Document.Parsed
  readonly lineCounter: LineCounter
  readonly file: string
}

/** 行列（1 基）。 */
export interface Loc {
  readonly line: number
  readonly column: number
}

/**
 * 解析 YAML 文本。
 *
 * @throws `policy-parse-error` 语法错误 / 重复键 / 别名展开
 */
export function parseYaml(text: string, file: string): YamlSource {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { uniqueKeys: true, lineCounter })

  const first = doc.errors[0]
  if (first !== undefined) {
    throw policyError('policy-parse-error', `YAML 解析失败：${first.message}`, {
      file,
      line: first.linePos?.[0].line ?? 1,
      column: first.linePos?.[0].col ?? 1,
    })
  }

  return { doc, lineCounter, file }
}

/** YAML → 普通对象（别名一律拒绝，避免"一份文本两种展开"）。 */
export function toPlain(source: YamlSource): unknown {
  try {
    return source.doc.toJS({ maxAliasCount: 0 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw policyError('policy-parse-error', `YAML 展开失败：${message}`, {
      file: source.file,
    })
  }
}

/** 某个 YAML 路径的起始行列；路径不存在时退化为 1:1（不抛错，定位是尽力而为）。 */
export function locOf(source: YamlSource, path: readonly (string | number)[]): Loc {
  const node = source.doc.getIn(path, true) as { range?: readonly [number, number, number] } | undefined
  const start = node?.range?.[0]
  if (start === undefined) return { line: 1, column: 1 }
  const pos = source.lineCounter.linePos(start)
  return { line: pos.line, column: pos.col }
}

/**
 * 标量**值内部**某个偏移对应的绝对行列。
 *
 * 精确范围：单行 plain 标量（本方案的规则写法）。引号标量会把起始列算在引号上，
 * 多行标量按换行数推进行号——两者都比"只报行号"更接近真相，且行为稳定可测。
 */
export function locIn(
  source: YamlSource,
  path: readonly (string | number)[],
  value: string,
  offset: number,
): Loc {
  const start = locOf(source, path)
  const prefix = value.slice(0, offset)
  const breaks = prefix.split('\n').length - 1
  if (breaks === 0) return { line: start.line, column: start.column + offset }
  return { line: start.line + breaks, column: offset - prefix.lastIndexOf('\n') }
}
