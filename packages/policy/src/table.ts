/**
 * 决策表：IR 形状、解析与求值（设计方案 01 §4）。
 *
 * 求值算法只有一份（§4.2）：`first-match` + 默认行；`raise` 只升不降，`deny` 终态。
 * 四条不变式（单调/确定/总函数/默认行必达）由 `table.test.ts` 与属性测试钉住。
 *
 * 解析阶段就把"形状错误"全部拦掉：一行只能有一个动作、`raise` 只能是黄/红、
 * `deny` 码必须在 manifest 声明过、`appliesTo` 必须在工具目录里。
 */

import { policyError } from './errors.ts'
import { POLICY_LIMITS } from './limits.ts'
import { evaluateCondition } from './expr/eval.ts'
import { parseExpression, toIr, type ExprNode, type IrExpr } from './expr/parser.ts'
import { checkCondition } from './expr/check.ts'
import { locIn, locOf, toPlain, type Loc, type YamlSource } from './yaml.ts'
import {
  isRecord,
  type BankTierInput,
  type ParamSpec,
  type TierLevel,
  type TierPolicyResult,
  type TierReason,
} from './schema.ts'

/** 行动作。 */
export type IrAction =
  | { readonly kind: 'raise'; readonly to: 'yellow' | 'red'; readonly reason: string }
  | { readonly kind: 'keep'; readonly reason?: string }
  | { readonly kind: 'deny'; readonly code: string; readonly reason: string }

/** IR 里的一行。 */
export interface IrRow {
  readonly id: string
  readonly when: IrExpr
  readonly action: IrAction
}

/** IR 里的一张表。 */
export interface IrTable {
  readonly id: string
  readonly appliesTo?: readonly string[]
  readonly requires?: readonly string[]
  readonly hit: 'first'
  readonly rows: readonly IrRow[]
}

/** 参数声明（IR 里的形态与 manifest 一致）。 */
export interface IrParameter {
  readonly type: 'integer'
  readonly min: number
  readonly max: number
}

/** 规范化 IR：唯一可执行形态，也是语义摘要的输入。 */
export interface PolicyIr {
  readonly apiVersion: 'bah.policy/v1'
  readonly kind: 'bank.tier'
  readonly name: string
  readonly version: string
  readonly schema: 'bank.tier.input/v1'
  readonly engine: { readonly min: string; readonly max: string }
  readonly parameters: Readonly<Record<string, IrParameter>>
  readonly reasons: readonly string[]
  readonly denyCodes: readonly string[]
  readonly tables: readonly IrTable[]
}

/** 解析上下文。 */
export interface TableContext {
  readonly source: YamlSource
  readonly params: Readonly<Record<string, ParamSpec>>
  readonly reasons: readonly string[]
  readonly denyCodes: readonly string[]
  readonly toolNames: readonly string[]
}

/** 解析后的一行（带源位置，供静态分析与报错）。 */
export interface ParsedRow {
  readonly id: string
  readonly when: IrExpr
  readonly ast: ExprNode
  readonly action: IrAction
  readonly loc: Loc
}

/** 解析后的一张表。 */
export interface ParsedTable {
  readonly id: string
  readonly rows: readonly ParsedRow[]
  readonly loc: Loc
}

/** 解析结果：IR + 带位置的中间结构（后者不参与摘要）。 */
export interface ParsedTables {
  readonly tables: readonly IrTable[]
  readonly parsed: readonly ParsedTable[]
}

const TABLE_KEYS = new Set(['id', 'appliesTo', 'requires', 'hit', 'rows', 'note'])
const ROW_KEYS = new Set(['id', 'when', 'raise', 'keep', 'deny', 'reason', 'note'])
const DENY_CODE_PATTERN = /^policy-[a-z][a-z0-9-]{1,40}$/

/**
 * 解析 `rules.yml`。
 *
 * @throws `policy-*` 任意形状/类型/语义错误（带 `file:line` 与 `ruleId`）
 */
export function readTables(context: TableContext): ParsedTables {
  const plain = toPlain(context.source)
  if (!isRecord(plain)) {
    throw at(context, [], 'policy-schema-invalid', 'rules.yml 根节点必须是对象')
  }
  rejectUnknown(context, plain, new Set(['tables']), [])

  const rawTables = plain['tables']
  if (!Array.isArray(rawTables) || rawTables.length === 0) {
    throw at(context, ['tables'], 'policy-schema-invalid', 'tables 必须是非空数组')
  }
  if (rawTables.length > POLICY_LIMITS.maxTables) {
    throw policyError('policy-limit-exceeded', `表数上限 ${String(POLICY_LIMITS.maxTables)}`, {
      file: context.source.file,
      limit: 'maxTables',
      max: POLICY_LIMITS.maxTables,
      size: rawTables.length,
    })
  }

  const tables: IrTable[] = []
  const parsed: ParsedTable[] = []
  const tableIds = new Set<string>()
  const rowIds = new Map<string, number>()

  for (const [tableIndex, rawTable] of rawTables.entries()) {
    const tablePath = ['tables', tableIndex]
    const table = requireRecord(context, rawTable, tablePath, '表')
    rejectUnknown(context, table, TABLE_KEYS, tablePath)

    const id = requireString(context, table['id'], [...tablePath, 'id'], '表 id')
    if (tableIds.has(id)) {
      throw at(context, [...tablePath, 'id'], 'policy-duplicate-rule', `表 ID 重复：${id}`, {
        id,
        table: id,
      })
    }
    tableIds.add(id)

    const hit = table['hit']
    if (hit !== 'first') {
      throw at(context, [...tablePath, 'hit'], 'policy-schema-invalid', 'v1 只支持 hit: first')
    }

    const appliesTo = readStringArray(context, table['appliesTo'], [...tablePath, 'appliesTo'], 'appliesTo')
    for (const [index, tool] of (appliesTo ?? []).entries()) {
      if (!context.toolNames.includes(tool)) {
        throw at(
          context,
          [...tablePath, 'appliesTo', index],
          'policy-unknown-tool',
          `工具 \`${tool}\` 不在工具目录中`,
          { name: tool },
        )
      }
    }

    const requires = readStringArray(context, table['requires'], [...tablePath, 'requires'], 'requires')
    for (const [index, key] of (requires ?? []).entries()) {
      if (key !== 'preview') {
        throw at(
          context,
          [...tablePath, 'requires', index],
          'policy-schema-invalid',
          `v1 的 requires 只允许 preview，实际 \`${key}\``,
          { field: 'requires', name: key },
        )
      }
    }

    const rawRows = table['rows']
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw at(context, [...tablePath, 'rows'], 'policy-schema-invalid', 'rows 必须是非空数组')
    }
    if (rawRows.length > POLICY_LIMITS.maxRowsPerTable) {
      throw policyError('policy-limit-exceeded', `单表行数上限 ${String(POLICY_LIMITS.maxRowsPerTable)}`, {
        file: context.source.file,
        limit: 'maxRowsPerTable',
        max: POLICY_LIMITS.maxRowsPerTable,
        size: rawRows.length,
      })
    }
    if (rawRows.length < 2) {
      throw at(
        context,
        [...tablePath, 'rows'],
        'policy-schema-invalid',
        '表至少 2 行（规则 + 默认行）',
      )
    }

    const rows: ParsedRow[] = []
    for (const [rowIndex, rawRow] of rawRows.entries()) {
      const rowPath = [...tablePath, 'rows', rowIndex]
      const row = requireRecord(context, rawRow, rowPath, '行')
      rejectUnknown(context, row, ROW_KEYS, rowPath)

      const rowId = requireString(context, row['id'], [...rowPath, 'id'], '行 id')
      const previous = rowIds.get(rowId)
      if (previous !== undefined) {
        throw at(context, [...rowPath, 'id'], 'policy-duplicate-rule', `规则 ID 重复：${rowId}`, {
          id: rowId,
          ruleId: rowId,
          firstLine: previous,
        })
      }
      rowIds.set(rowId, locOf(context.source, [...rowPath, 'id']).line)

      // `when: true` 在 YAML 里是布尔值，不是字符串——默认行就是这么写的。
      const rawWhen = row['when']
      const whenText =
        typeof rawWhen === 'boolean'
          ? String(rawWhen)
          : requireString(context, rawWhen, [...rowPath, 'when'], 'when ')
      const ast = parseCondition(context, whenText, [...rowPath, 'when'], rowId, requires ?? [])
      const action = readAction(context, row, rowPath, rowId)

      rows.push({
        id: rowId,
        when: toIr(ast),
        ast,
        action,
        loc: locOf(context.source, [...rowPath, 'id']),
      })
    }

    const last = rows[rows.length - 1] as ParsedRow
    if (!(last.ast.kind === 'bool' && last.ast.value)) {
      throw at(
        context,
        [...tablePath, 'rows', rows.length - 1, 'when'],
        'policy-missing-default',
        '最后一行必须是默认行 `when: true`',
        { table: id, ruleId: last.id },
      )
    }

    tables.push({
      id,
      ...(appliesTo === undefined ? {} : { appliesTo }),
      ...(requires === undefined ? {} : { requires }),
      hit: 'first',
      rows: rows.map((row) => ({ id: row.id, when: row.when, action: row.action })),
    })
    parsed.push({ id, rows, loc: locOf(context.source, [...tablePath, 'id']) })
  }

  return { tables, parsed }
}

/** 解析并类型检查一条 `when`；把表达式内偏移映射回 YAML 行列。 */
function parseCondition(
  context: TableContext,
  text: string,
  path: readonly (string | number)[],
  ruleId: string,
  requires: readonly string[],
): ExprNode {
  let ast: ExprNode
  try {
    ast = parseExpression(text)
    checkCondition(ast, { params: context.params, requires: new Set(requires) })
  } catch (error) {
    throw relocate(context, error, path, text, ruleId)
  }
  return ast
}

/** 读一行的动作（三选一），并把语义错误全部前置到编译期。 */
function readAction(
  context: TableContext,
  row: Record<string, unknown>,
  rowPath: readonly (string | number)[],
  ruleId: string,
): IrAction {
  const present: string[] = []
  if (row['raise'] !== undefined) present.push('raise')
  if (row['keep'] !== undefined) present.push('keep')
  if (row['deny'] !== undefined) present.push('deny')

  if (present.length === 0) {
    throw at(context, rowPath, 'policy-schema-invalid', '每行必须有 raise/keep/deny 之一', {
      ruleId,
    })
  }
  if (present.length > 1) {
    throw at(
      context,
      rowPath,
      'policy-row-action-conflict',
      `一行只能有一个动作，实际有 ${present.join('/')}`,
      { ruleId },
    )
  }

  const reason = row['reason']
  if (present[0] === 'raise') {
    const to = row['raise']
    if (to === 'green') {
      throw at(context, [...rowPath, 'raise'], 'policy-lower-tier', '不支持降级到 green', {
        ruleId,
        declared: 'green',
      })
    }
    if (to !== 'yellow' && to !== 'red') {
      throw at(context, [...rowPath, 'raise'], 'policy-schema-invalid', 'raise 只接受 yellow|red', {
        ruleId,
        actual: String(to),
      })
    }
    return {
      kind: 'raise',
      to,
      reason: requireReason(context, reason, rowPath, ruleId),
    }
  }

  if (present[0] === 'keep') {
    if (row['keep'] !== true) {
      throw at(context, [...rowPath, 'keep'], 'policy-schema-invalid', 'keep 只接受 true', {
        ruleId,
      })
    }
    return reason === undefined
      ? { kind: 'keep' }
      : { kind: 'keep', reason: requireReason(context, reason, rowPath, ruleId) }
  }

  const code = row['deny']
  if (typeof code !== 'string' || !DENY_CODE_PATTERN.test(code)) {
    throw at(
      context,
      [...rowPath, 'deny'],
      'policy-bad-deny-code',
      `拒绝码必须匹配 ${DENY_CODE_PATTERN.source}`,
      { ruleId, code: String(code) },
    )
  }
  if (!context.denyCodes.includes(code)) {
    throw at(context, [...rowPath, 'deny'], 'policy-bad-deny-code', `拒绝码 \`${code}\` 未在 denyCodes 声明`, {
      ruleId,
      code,
    })
  }
  return { kind: 'deny', code, reason: requireReason(context, reason, rowPath, ruleId) }
}

/** 理由必填且必须在词表内。 */
function requireReason(
  context: TableContext,
  value: unknown,
  rowPath: readonly (string | number)[],
  ruleId: string,
): string {
  if (typeof value !== 'string') {
    throw at(context, rowPath, 'policy-bad-reason', '该动作必须写 reason', { ruleId })
  }
  if (!context.reasons.includes(value)) {
    throw at(context, [...rowPath, 'reason'], 'policy-bad-reason', `理由 \`${value}\` 不在词表内`, {
      ruleId,
      reason: value,
    })
  }
  return value
}

function requireRecord(
  context: TableContext,
  value: unknown,
  path: readonly (string | number)[],
  what: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw at(context, path, 'policy-schema-invalid', `${what}必须是对象`)
  }
  return value
}

function requireString(
  context: TableContext,
  value: unknown,
  path: readonly (string | number)[],
  what: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw at(context, path, 'policy-schema-invalid', `${what}必须是非空字符串`)
  }
  return value
}

function readStringArray(
  context: TableContext,
  value: unknown,
  path: readonly (string | number)[],
  what: string,
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw at(context, path, 'policy-schema-invalid', `${what} 必须是字符串数组`)
  }
  return value as string[]
}

/** 未知键一律拒绝；`lower` 单独给"降级"的码（比"未知键"更能说明问题）。 */
function rejectUnknown(
  context: TableContext,
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: readonly (string | number)[],
): void {
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue
    if (key === 'lower' || key === 'level') {
      throw at(context, [...path, key], 'policy-lower-tier', `不支持降级字段 \`${key}\``, {
        key,
      })
    }
    throw at(context, [...path, key], 'policy-unknown-key', `未知字段 \`${key}\``, { key })
  }
}

/** 以 YAML 路径定位并抛错。 */
function at(
  context: TableContext,
  path: readonly (string | number)[],
  code: Parameters<typeof policyError>[0],
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const loc = locOf(context.source, path)
  return policyError(code, message, {
    file: context.source.file,
    line: loc.line,
    column: loc.column,
    ...extra,
  })
}

/** 把表达式内的 1 基列偏移换成 YAML 的绝对行列。 */
function relocate(
  context: TableContext,
  error: unknown,
  path: readonly (string | number)[],
  text: string,
  ruleId: string,
): Error {
  const detail = (error as { detail?: { column?: number } }).detail
  const offset = Math.max((detail?.column ?? 1) - 1, 0)
  const loc = locIn(context.source, path, text, offset)
  const code = (error as { code?: string }).code ?? 'policy-parse-error'
  const message = (error as { message?: string }).message ?? '表达式不合法'
  return policyError(code as Parameters<typeof policyError>[0], message, {
    file: context.source.file,
    line: loc.line,
    column: loc.column,
    ruleId,
  })
}

/** 级别排序（green < yellow < red）。 */
const LEVEL_RANK: Readonly<Record<TierLevel, number>> = { green: 0, yellow: 1, red: 2 }

/** 取更高的一级（同级别返回 `left`）。 */
export function maxLevel(left: TierLevel, right: TierLevel): TierLevel {
  return LEVEL_RANK[right] > LEVEL_RANK[left] ? right : left
}

/**
 * 求值（§4.2 的唯一实现）。
 *
 * 输入在 `validateInput` 里已深冻结；这里只读。
 */
export function evaluateIr(ir: PolicyIr, input: BankTierInput): TierPolicyResult {
  let level: TierLevel = input.action.declared
  let reason: TierReason = 'declared'
  const ruleIds: string[] = []
  const tables: string[] = []

  for (const table of ir.tables) {
    if (table.appliesTo !== undefined && !table.appliesTo.includes(input.action.name)) continue
    if (table.requires !== undefined && !table.requires.every((key) => isPresent(input, key))) continue
    tables.push(table.id)

    for (const row of table.rows) {
      if (!evaluateCondition(row.when, { ...input, level, reason })) continue
      ruleIds.push(row.id)

      if (row.action.kind === 'deny') {
        return {
          level,
          reason: row.action.reason as TierReason,
          deny: { code: row.action.code, reason: row.action.reason },
          ruleIds,
          tables,
        }
      }
      if (row.action.kind === 'raise') {
        level = maxLevel(level, row.action.to)
        reason = row.action.reason as TierReason
      } else if (row.action.reason !== undefined) {
        reason = row.action.reason as TierReason
      }
      break
    }
  }

  return { level, reason, ruleIds, tables }
}

/** `requires` 的字段是否存在于输入（只认 `preview`，v1 的唯一可选子树）。 */
function isPresent(input: BankTierInput, key: string): boolean {
  return (input as unknown as Record<string, unknown>)[key] !== undefined
}
