/**
 * 语料、规则覆盖与变异敏感性（施工方案 04 §3）。
 *
 * 语料不是"示例"，是**验收装置**：每条规则（含默认行）至少被命中一次、四种理由各一次、
 * 金额与阈值边界各一次。少一条就是 `policy:test` 红。
 *
 * 变异测试在 **IR 层**做（比较符翻转 / 常量 ±1 / 动作改变 / 理由改变 / 删行），
 * 不重写 YAML：这样"变异体"和"生产求值"走同一条代码路径，杀不死就是语料不够。
 */

import { canonicalJson } from '@bah/util'

import { policyError } from './errors.ts'
import { locOf, toPlain, type YamlSource } from './yaml.ts'
import {
  isRecord,
  TIER_LEVELS,
  TIER_REASONS,
  validateInput,
  type BankTierInput,
  type ParamSpec,
  type TierLevel,
  type TierPolicyResult,
  type TierReason,
} from './schema.ts'
import { kindOf } from './expr/eval.ts'
import type { BinaryOp, IrExpr } from './expr/parser.ts'
import type { IrRow, PolicyIr } from './table.ts'

/** 语料用例。 */
export interface CorpusCase {
  readonly id: string
  readonly note?: string
  readonly tags?: readonly string[]
  readonly input: BankTierInput
  readonly expect: {
    readonly level: TierLevel
    readonly reason: TierReason
    readonly ruleIds?: readonly string[]
    readonly deny?: { readonly code: string; readonly reason: string }
  }
}

/** 求值器（`CompiledPolicy` 满足它；分开定义避免 corpus ↔ compile 循环）。 */
export interface Evaluator {
  evaluate(input: BankTierInput): TierPolicyResult
}

/** 一条失败。 */
export interface CorpusFailure {
  readonly caseId: string
  readonly field: string
  readonly expected: string
  readonly actual: string
}

/** 覆盖摘要（`policy:test --coverage` 的输出）。 */
export interface CoverageSummary {
  readonly cases: number
  readonly rules: readonly string[]
  readonly missingRules: readonly string[]
  readonly reasons: readonly string[]
  readonly missingReasons: readonly string[]
  readonly actions: Readonly<Record<string, number>>
  readonly declared: readonly string[]
  readonly bindings: readonly string[]
  readonly tags: readonly string[]
  readonly tagCounts: Readonly<Record<string, number>>
  /** 所有覆盖缺口（空数组 = 合格）。 */
  readonly violations: readonly string[]
}

/** 语料跑批结果。 */
export interface CorpusReport {
  readonly failures: readonly CorpusFailure[]
  readonly coverage: CoverageSummary
}

/** 必须出现的边界标签（04 §3.1 第 4、5 条）。 */
export const REQUIRED_TAGS = ['limit-eq', 'limit+1', 'threshold-1', 'threshold', 'threshold+1'] as const

/**
 * 解析 `corpus.yml`。
 *
 * @throws `policy-*` 形状/类型错误（带 `file:line` 与 `caseId`）
 */
export function readCorpus(
  source: YamlSource,
  params: Readonly<Record<string, ParamSpec>>,
  reasons: readonly string[],
): CorpusCase[] {
  const plain = toPlain(source)
  if (!isRecord(plain)) throw at(source, [], 'policy-schema-invalid', 'corpus.yml 根节点必须是对象')
  rejectUnknown(source, plain, new Set(['cases']), [])

  const rawCases = plain['cases']
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw at(source, ['cases'], 'policy-schema-invalid', 'cases 必须是非空数组')
  }

  const cases: CorpusCase[] = []
  const seen = new Set<string>()

  for (const [index, rawCase] of rawCases.entries()) {
    const path = ['cases', index]
    if (!isRecord(rawCase)) throw at(source, path, 'policy-schema-invalid', '用例必须是对象')
    rejectUnknown(source, rawCase, new Set(['id', 'note', 'tags', 'input', 'expect']), path)

    const id = rawCase['id']
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw at(source, [...path, 'id'], 'policy-schema-invalid', '用例 id 必须是非空字符串')
    }
    if (seen.has(id)) {
      throw at(source, [...path, 'id'], 'policy-duplicate-rule', `用例 ID 重复：${id}`, {
        id,
        caseId: id,
      })
    }
    seen.add(id)

    const note = rawCase['note']
    if (note !== undefined && typeof note !== 'string') {
      throw at(source, [...path, 'note'], 'policy-schema-invalid', 'note 必须是字符串')
    }

    const tags = rawCase['tags']
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) {
      throw at(source, [...path, 'tags'], 'policy-schema-invalid', 'tags 必须是字符串数组')
    }

    const input = readCaseInput(source, rawCase['input'], [...path, 'input'], params, id)
    const expect = readExpect(source, rawCase['expect'], [...path, 'expect'], reasons, id)

    cases.push({
      id,
      ...(note === undefined ? {} : { note }),
      ...(tags === undefined ? {} : { tags: tags as string[] }),
      input,
      expect,
    })
  }

  return cases
}

function readCaseInput(
  source: YamlSource,
  value: unknown,
  path: readonly (string | number)[],
  params: Readonly<Record<string, ParamSpec>>,
  caseId: string,
): BankTierInput {
  try {
    return validateInput(value, params)
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'policy-schema-invalid'
    const message = (error as { message?: string }).message ?? '用例输入非法'
    const loc = locOf(source, path)
    throw policyError(code as Parameters<typeof policyError>[0], message, {
      file: source.file,
      line: loc.line,
      column: loc.column,
      caseId,
    })
  }
}

function readExpect(
  source: YamlSource,
  value: unknown,
  path: readonly (string | number)[],
  reasons: readonly string[],
  caseId: string,
): CorpusCase['expect'] {
  if (!isRecord(value)) throw at(source, path, 'policy-schema-invalid', 'expect 必须是对象')
  rejectUnknown(source, value, new Set(['level', 'reason', 'ruleIds', 'deny']), path)

  const level = value['level']
  if (typeof level !== 'string' || !TIER_LEVELS.includes(level as TierLevel)) {
    throw at(source, [...path, 'level'], 'policy-schema-invalid', 'expect.level 必须是 green|yellow|red', {
      caseId,
    })
  }

  const reason = value['reason']
  if (typeof reason !== 'string' || !reasons.includes(reason)) {
    throw at(source, [...path, 'reason'], 'policy-bad-reason', `expect.reason \`${String(reason)}\` 不在词表内`, {
      caseId,
      reason: String(reason),
    })
  }

  const ruleIds = value['ruleIds']
  if (ruleIds !== undefined && (!Array.isArray(ruleIds) || ruleIds.some((item) => typeof item !== 'string'))) {
    throw at(source, [...path, 'ruleIds'], 'policy-schema-invalid', 'ruleIds 必须是字符串数组', {
      caseId,
    })
  }

  const deny = value['deny']
  if (deny !== undefined) {
    if (!isRecord(deny) || typeof deny['code'] !== 'string' || typeof deny['reason'] !== 'string') {
      throw at(source, [...path, 'deny'], 'policy-schema-invalid', 'deny 必须是 { code, reason }', {
        caseId,
      })
    }
    return {
      level: level as TierLevel,
      reason: reason as TierReason,
      ...(ruleIds === undefined ? {} : { ruleIds: ruleIds as string[] }),
      deny: { code: deny['code'], reason: deny['reason'] },
    }
  }

  return {
    level: level as TierLevel,
    reason: reason as TierReason,
    ...(ruleIds === undefined ? {} : { ruleIds: ruleIds as string[] }),
  }
}

/**
 * 跑语料并统计覆盖。
 *
 * 失败**不早退**：一次把所有差异报出来，改规则的人不用"修一条跑一次"。
 */
export function runCorpus(
  ir: PolicyIr,
  cases: readonly CorpusCase[],
  evaluator: Evaluator,
): CorpusReport {
  const failures: CorpusFailure[] = []
  const hitRules = new Set<string>()
  const hitReasons = new Set<string>()
  const actionCounts: Record<string, number> = {}
  const declared = new Set<string>()
  const bindings = new Set<string>()
  const tags = new Set<string>()
  const tagCounts: Record<string, number> = {}

  for (const item of cases) {
    const actual = evaluator.evaluate(item.input)

    for (const ruleId of actual.ruleIds) hitRules.add(ruleId)
    hitReasons.add(actual.reason)
    declared.add(item.input.action.declared)
    if (item.input.preview !== undefined) bindings.add(item.input.preview.payee.binding)
    for (const tag of item.tags ?? []) {
      tags.add(tag)
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1
    }

    failures.push(...compareCase(item, actual))
  }

  for (const table of ir.tables) {
    for (const row of table.rows) {
      if (!hitRules.has(row.id)) continue
      const key = actionKey(row)
      actionCounts[key] = (actionCounts[key] ?? 0) + 1
    }
  }

  const totalRules = ir.tables.flatMap((table) => table.rows.map((row) => row.id))
  const missingRules = totalRules.filter((id) => !hitRules.has(id))
  const missingReasons = ir.reasons.filter((reason) => !hitReasons.has(reason))
  const hasPreview = cases.some((item) => item.input.preview !== undefined)
  const missingBindings = hasPreview
    ? ['new', 'whitelist'].filter((binding) => !bindings.has(binding))
    : []
  const missingTags = REQUIRED_TAGS.filter((tag) => !tags.has(tag))
  const missingDeclared = TIER_LEVELS.filter((level) => !declared.has(level))

  const violations = [
    ...missingRules.map((id) => `row:${id}`),
    ...missingReasons.map((reason) => `reason:${reason}`),
    ...missingDeclared.map((level) => `declared:${level}`),
    ...missingBindings.map((binding) => `binding:${binding}`),
    ...missingTags.map((tag) => `tag:${tag}`),
  ]

  return {
    failures,
    coverage: {
      cases: cases.length,
      rules: totalRules.filter((id) => hitRules.has(id)),
      missingRules,
      reasons: ir.reasons.filter((reason) => hitReasons.has(reason)),
      missingReasons,
      actions: actionCounts,
      declared: TIER_LEVELS.filter((level) => declared.has(level)),
      bindings: ['new', 'whitelist'].filter((binding) => bindings.has(binding)),
      tags: REQUIRED_TAGS.filter((tag) => tags.has(tag)),
      tagCounts,
      violations,
    },
  }
}

function compareCase(item: CorpusCase, actual: TierPolicyResult): CorpusFailure[] {
  const failures: CorpusFailure[] = []
  if (actual.level !== item.expect.level) {
    failures.push({
      caseId: item.id,
      field: 'level',
      expected: item.expect.level,
      actual: actual.level,
    })
  }
  if (actual.reason !== item.expect.reason) {
    failures.push({
      caseId: item.id,
      field: 'reason',
      expected: item.expect.reason,
      actual: actual.reason,
    })
  }
  if (item.expect.ruleIds !== undefined) {
    const expected = canonicalJson(item.expect.ruleIds)
    const observed = canonicalJson(actual.ruleIds)
    if (expected !== observed) {
      failures.push({ caseId: item.id, field: 'ruleIds', expected, actual: observed })
    }
  }
  const expectedDeny = canonicalJson(item.expect.deny ?? null)
  const actualDeny = canonicalJson(actual.deny ?? null)
  if (expectedDeny !== actualDeny) {
    failures.push({ caseId: item.id, field: 'deny', expected: expectedDeny, actual: actualDeny })
  }
  return failures
}

/** 动作的报表键（`raise-red` / `keep` / `deny`）。 */
function actionKey(row: IrRow): string {
  return row.action.kind === 'raise' ? `raise-${row.action.to}` : row.action.kind
}

/** 一个变异体。 */
export interface Mutant {
  readonly rowId: string
  readonly kind: 'flip-comparison' | 'const-offset' | 'action' | 'reason' | 'delete-row'
  readonly tables: PolicyIr['tables']
}

/** 变异结果。 */
export interface MutationReport {
  readonly total: number
  readonly killed: number
  readonly score: number
  /** 未被任何用例杀死的变异体。 */
  readonly surviving: readonly string[]
  /** 没有任何变异体覆盖到的行（说明变异器没造出来）。 */
  readonly unmutated: readonly string[]
}

/**
 * 生成变异体并跑语料。
 *
 * @returns 变异分数；`policy:test` 要求 `surviving` 为空且 `unmutated` 为空
 */
export function mutateAndKill(
  ir: PolicyIr,
  cases: readonly CorpusCase[],
  evaluatorOf: (candidate: PolicyIr) => Evaluator,
): MutationReport {
  const mutants = buildMutants(ir)
  const surviving: string[] = []
  const killedRows = new Set<string>()

  for (const mutant of mutants) {
    const evaluator = evaluatorOf({ ...ir, tables: mutant.tables })
    const killed = cases.some((item) => compareCase(item, evaluator.evaluate(item.input)).length > 0)
    if (killed) killedRows.add(mutant.rowId)
    else surviving.push(`${mutant.rowId}:${mutant.kind}`)
  }

  const rows = ir.tables.flatMap((table) => table.rows.map((row) => row.id))
  const unmutated = rows.filter((id) => !mutants.some((mutant) => mutant.rowId === id))

  return {
    total: mutants.length,
    killed: mutants.length - surviving.length,
    score: mutants.length === 0 ? 0 : (mutants.length - surviving.length) / mutants.length,
    surviving,
    unmutated,
  }
}

/** 为每一行生成 4–5 类变异（不适用就跳过：例如没有常量就没有 `const-offset`）。 */
function buildMutants(ir: PolicyIr): Mutant[] {
  const mutants: Mutant[] = []

  for (const [tableIndex, table] of ir.tables.entries()) {
    for (const [rowIndex, row] of table.rows.entries()) {
      const replace = (next: IrRow): PolicyIr['tables'] =>
        ir.tables.map((candidate, index) =>
          index === tableIndex
            ? { ...candidate, rows: candidate.rows.map((item, at) => (at === rowIndex ? next : item)) }
            : candidate,
        )

      const flipped = flipComparison(row.when)
      if (flipped !== undefined) {
        mutants.push({ rowId: row.id, kind: 'flip-comparison', tables: replace({ ...row, when: flipped }) })
      }

      const offset = offsetConstant(row.when)
      if (offset !== undefined) {
        mutants.push({ rowId: row.id, kind: 'const-offset', tables: replace({ ...row, when: offset }) })
      }

      mutants.push({ rowId: row.id, kind: 'action', tables: replace({ ...row, action: changedAction(row) }) })

      const reason = changedReason(row, ir.reasons)
      if (reason !== undefined) {
        mutants.push({ rowId: row.id, kind: 'reason', tables: replace({ ...row, action: reason }) })
      }

      const remaining = table.rows.filter((_, at) => at !== rowIndex)
      mutants.push({
        rowId: row.id,
        kind: 'delete-row',
        tables: ir.tables.map((candidate, index) =>
          index === tableIndex ? { ...candidate, rows: remaining } : candidate,
        ),
      })
    }
  }

  return mutants
}

/** 翻转第一个比较符。 */
function flipComparison(node: IrExpr): IrExpr | undefined {
  const kind = kindOf(node)
  if (kind === 'binary') {
    const binary = node as { op: BinaryOp; left: IrExpr; right: IrExpr }
    if (isComparison(binary.op)) {
      return { ...binary, op: flipOperator(binary.op) }
    }
    const left = flipComparison(binary.left)
    if (left !== undefined) return { ...binary, left }
    const right = flipComparison(binary.right)
    if (right !== undefined) return { ...binary, right }
    return undefined
  }
  if (kind === 'unary') {
    const unary = node as { op: 'not' | 'neg'; arg: IrExpr }
    const arg = flipComparison(unary.arg)
    return arg === undefined ? undefined : { ...unary, arg }
  }
  return undefined
}

/** 第一个整数字面量 +1。 */
function offsetConstant(node: IrExpr): IrExpr | undefined {
  const kind = kindOf(node)
  if (kind === 'int') return { int: (node as { int: number }).int + 1 }
  if (kind === 'binary') {
    const binary = node as { op: BinaryOp; left: IrExpr; right: IrExpr }
    const left = offsetConstant(binary.left)
    if (left !== undefined) return { ...binary, left }
    const right = offsetConstant(binary.right)
    if (right !== undefined) return { ...binary, right }
    return undefined
  }
  if (kind === 'unary') {
    const unary = node as { op: 'not' | 'neg'; arg: IrExpr }
    const arg = offsetConstant(unary.arg)
    return arg === undefined ? undefined : { ...unary, arg }
  }
  return undefined
}

function changedAction(row: IrRow): IrRow['action'] {
  if (row.action.kind === 'raise') {
    return { kind: 'keep', reason: row.action.reason }
  }
  return { kind: 'raise', to: 'red', reason: 'declared' }
}

function changedReason(row: IrRow, reasons: readonly string[]): IrRow['action'] | undefined {
  const current = row.action.reason
  if (current === undefined) return undefined
  const next = reasons.find((reason) => reason !== current)
  if (next === undefined) return undefined
  if (row.action.kind === 'deny') return { kind: 'deny', code: row.action.code, reason: next }
  if (row.action.kind === 'raise') return { kind: 'raise', to: row.action.to, reason: next }
  return { kind: 'keep', reason: next }
}

type ComparisonOp = '==' | '!=' | '<' | '<=' | '>' | '>='

function isComparison(op: BinaryOp): op is ComparisonOp {
  return op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>='
}

/** 比较符翻转表（只对比较符有定义；非比较符不会走到这里）。 */
const FLIPPED: Readonly<Record<ComparisonOp, ComparisonOp>> = {
  '<': '>=',
  '<=': '>',
  '>': '<=',
  '>=': '<',
  '==': '!=',
  '!=': '==',
}

function flipOperator(op: ComparisonOp): ComparisonOp {
  return FLIPPED[op]
}

function at(
  source: YamlSource,
  path: readonly (string | number)[],
  code: Parameters<typeof policyError>[0],
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const loc = locOf(source, path)
  return policyError(code, message, {
    file: source.file,
    line: loc.line,
    column: loc.column,
    ...extra,
  })
}

function rejectUnknown(
  source: YamlSource,
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: readonly (string | number)[],
): void {
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue
    throw at(source, [...path, key], 'policy-unknown-key', `未知字段 \`${key}\``, { key })
  }
}
