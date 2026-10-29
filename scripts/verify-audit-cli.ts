/**
 * 门禁：`bah audit` 命令面契约（施工单 16 §10）。
 *
 * 六条断言：
 * 1. `docs/audit.md` 的 flag 集合与 `AUDIT_HELP` 逐字一致；
 * 2. `Command` 联合成员恰为 `run` / `audit`，且分流 switch 以 `assertNever` 收尾；
 * 3. `audit.ts` 的数字 return 只用 0/1/2；
 * 4. `audit-report.ts` 不得 import `@bah/saga`（包边界）；
 * 5. audit 相关源码不得出现 `createSagaStore`（R159/R163 的零写防线）；
 * 6. 真实 JSON 输出包含约定字段（字段即契约）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ts from 'typescript'

import { AUDIT_HELP, runAudit } from '../packages/cli/src/cli/audit.ts'
import { createSagaAudit } from '../packages/persistence/src/index.ts'
import { isMainModule, runStandalone, type Gate, type GateResult } from './gate-lib.ts'

const AUDIT_SOURCES = [
  'packages/cli/src/cli/audit.ts',
  'packages/cli/src/cli/audit-projection.ts',
  'packages/cli/src/cli/audit-anchors.ts',
  'packages/persistence/src/chain/audit-report.ts',
] as const

const TOP_LEVEL_KEYS = [
  'dir',
  'db',
  'chains',
  'anchors',
  'reverseGaps',
  'errors',
  'dbState',
  'ok',
  'exitCode',
] as const

const CHAIN_KEYS = [
  'sagaId',
  'events',
  'chainOk',
  'brokenAt',
  'signedExpected',
  'signedPresent',
  'unsignedTypes',
  'signatureState',
  'signatureError',
  'projectionState',
  'projectionDiff',
] as const

const gate: Gate = {
  name: 'audit-cli',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const docText = readText(root, 'docs/audit.md')
    const helpFlags = flagsOf(AUDIT_HELP)
    // `scripts/replay.ts` 的 flag 不属于 `bah audit` 命令面；文档里这些行单独跳过
    // （W15：独立重放脚本与 CLI 共享重放逻辑，但参数面不同）。
    const docFlags = flagsOf(
      docText
        .split(String.fromCharCode(10))
        .filter((line) => !line.includes('scripts/replay.ts'))
        .join(String.fromCharCode(10)),
    )
    for (const flag of helpFlags) {
      if (!docFlags.has(flag)) findings.push(`docs/audit.md 缺少 flag：${flag}`)
    }
    for (const flag of docFlags) {
      if (!helpFlags.has(flag)) findings.push(`docs/audit.md 多出未实现 flag：${flag}`)
    }
    notes.push(`flag 契约：帮助 ${helpFlags.size} 个，文档 ${docFlags.size} 个`)

    const commandSource = sourceOf(root, 'packages/cli/src/cli/command.ts')
    const kinds = commandKinds(commandSource)
    // 契约会扩：HP-0 加了 `sentry`（人工解冻断路器），W07 加了 `halt` / `unfreeze`
    // （全系统停机与 MFA 票据解除），可观测性 03 加了 `metrics` / `trace` / `cost`。
    // 这里维护的是**允许集合**，新增子命令必须同步改这一行
    // ——门禁不是"记住最早那两个"，是"别悄悄多出来一个"。
    const EXPECTED_KINDS = ['audit', 'run', 'sentry', 'halt', 'unfreeze', 'metrics', 'trace', 'cost'] as const
    const missing = EXPECTED_KINDS.filter((kind) => !kinds.includes(kind))
    const extra = kinds.filter((kind) => !EXPECTED_KINDS.includes(kind as (typeof EXPECTED_KINDS)[number]))
    if (missing.length > 0 || extra.length > 0) {
      findings.push(
        `Command 联合应为 {${EXPECTED_KINDS.join(',')}}，实测：{${kinds.join(',') || '<空>'}}`,
      )
    }
    const runSource = sourceOf(root, 'packages/cli/src/cli/run.ts')
    const switchInfo = commandSwitch(runSource)
    if (!switchInfo.hasRun || !switchInfo.hasAudit) {
      findings.push('run.ts 缺少 command.kind 的 run/audit 分支')
    }
    if (!switchInfo.hasAssertNever) {
      findings.push('run.ts 的 command.kind switch 没有 default: assertNever 收尾')
    }
    notes.push(`Command 联合：${kinds.join('/')}；分流 assertNever=${switchInfo.hasAssertNever}`)

    const auditSource = sourceOf(root, 'packages/cli/src/cli/audit.ts')
    const returns = numericReturns(auditSource)
    for (const value of returns) {
      if (value !== 0 && value !== 1 && value !== 2) {
        findings.push(`audit.ts 出现非法数字退出码：${value}`)
      }
    }
    notes.push(`audit.ts 数字 return：${[...new Set(returns)].sort().join('/') || '<无>'}`)

    const reportText = readText(root, 'packages/persistence/src/chain/audit-report.ts')
    if (/@bah\/saga/.test(reportText)) {
      findings.push('audit-report.ts 不得 import @bah/saga（包边界）')
    }

    for (const source of AUDIT_SOURCES) {
      if (/\bcreateSagaStore\b/.test(readText(root, source))) {
        findings.push(`${source}: 不得出现 createSagaStore（零写防线）`)
      }
    }

    const contract = await contractCheck(root)
    findings.push(...contract.findings)
    notes.push(...contract.notes)

    return { ok: findings.length === 0, findings, notes }
  },
}

function readText(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

function sourceOf(root: string, rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, readText(root, rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 从帮助文本/文档里抽取 `--flag` 集合（去重）。 */
function flagsOf(text: string): Set<string> {
  return new Set([...text.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]))
}

/** `Command` 联合里的 `kind` 字面量。 */
function commandKinds(source: ts.SourceFile): string[] {
  const kinds: string[] = []
  for (const statement of source.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== 'Command') continue
    if (!ts.isUnionTypeNode(statement.type)) continue
    for (const member of statement.type.types) {
      if (!ts.isTypeLiteralNode(member)) continue
      for (const property of member.members) {
        if (!ts.isPropertySignature(property)) continue
        if (property.name?.getText(source) !== 'kind') continue
        const type = property.type
        if (type !== undefined && ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
          kinds.push(type.literal.text)
        }
      }
    }
  }
  return kinds.sort()
}

/** `run.ts` 里 `switch (command.kind)` 的分支与 assertNever 收尾。 */
function commandSwitch(source: ts.SourceFile): {
  readonly hasRun: boolean
  readonly hasAudit: boolean
  readonly hasAssertNever: boolean
} {
  let hasRun = false
  let hasAudit = false
  let hasAssertNever = false

  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node) && node.expression.getText(source) === 'command.kind') {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          const label = clause.expression.getText(source).replace(/['"]/g, '')
          if (label === 'run') hasRun = true
          if (label === 'audit') hasAudit = true
          continue
        }
        for (const statement of clause.statements) {
          if (!ts.isReturnStatement(statement) || statement.expression === undefined) continue
          if (!ts.isCallExpression(statement.expression)) continue
          const call = statement.expression
          if (
            call.expression.getText(source) === 'assertNever' &&
            call.arguments[0]?.getText(source) === 'command'
          ) {
            hasAssertNever = true
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { hasRun, hasAudit, hasAssertNever }
}

/** `audit.ts` 中所有数字字面量 return。 */
function numericReturns(source: ts.SourceFile): number[] {
  const values: number[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      ts.isNumericLiteral(node.expression)
    ) {
      values.push(Number(node.expression.text))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}

/** 用临时链跑一次真实命令，锁住 JSON 字段集合。 */
async function contractCheck(root: string): Promise<Pick<GateResult, 'findings' | 'notes'>> {
  const findings: string[] = []
  const notes: string[] = []
  const temp = mkdtempSync(join(tmpdir(), 'bah-audit-gate-'))
  try {
    mkdirSync(temp, { recursive: true })
    const writer = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: temp,
      fsync: false,
      signedTypes: [],
      warn: () => undefined,
    })
    writer.append('gate', 'saga/created', { sagaId: 'gate' })

    const out: string[] = []
    const err: string[] = []
    const code = await runAudit(
      ['--dir', temp, '--no-projection', '--no-signature', '--format', 'json'],
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      { root, now: () => 1_700_000_000_000 },
    )
    if (code !== 0) findings.push(`JSON 契约夹具退出码 ${code}（期望 0）：${err.join('; ')}`)
    let report: Record<string, unknown>
    try {
      report = JSON.parse(out.join('\n')) as Record<string, unknown>
    } catch {
      findings.push('JSON 契约夹具输出不是合法 JSON')
      return { findings, notes }
    }
    for (const key of TOP_LEVEL_KEYS) {
      if (!(key in report)) findings.push(`JSON 顶层缺字段：${key}`)
    }
    const chains = report['chains']
    if (!Array.isArray(chains) || chains.length !== 1) {
      findings.push('JSON chains 应为 1 条')
    } else {
      const chain = chains[0] as Record<string, unknown>
      for (const key of CHAIN_KEYS) {
        if (!(key in chain)) findings.push(`JSON chain 缺字段：${key}`)
      }
    }
    notes.push(`JSON 契约：顶层 ${TOP_LEVEL_KEYS.length} 字段、chain ${CHAIN_KEYS.length} 字段`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  return { findings, notes }
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
