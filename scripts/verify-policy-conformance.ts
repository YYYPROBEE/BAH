/**
 * 门禁：策略语料、覆盖、穷举等价、属性与变异敏感性（03 §7.2）。
 *
 * 五条判据：
 * 1. 每个 **production** bundle（registry `demo !== true`）的语料全绿、覆盖无缺口；
 *    `demo: true` 的候选只要求**用例通过**（覆盖/变异/等价都不要求，演示 bundle 不是生产真相源）；
 * 2. 规则覆盖：每条规则至少被一个用例命中，四种理由各一次；
 * 3. 穷举等价：`bank-tier/1.0.0` 与 `tier.ts` legacy 在 04 §2.2 的 960 组输入域上：
 *    480 组已绑定逐字段相等 + 480 组未绑定只验 `no-identity` 边界（bundle 不接收未绑定输入）；
 * 4. 属性：单调（level ≥ declared）、确定（两次全等）、总函数（不抛）、输入不被修改；
 * 5. 变异（仅 production）：每条规则至少被四类变异杀掉；有存活变异体 → 红。
 *
 * **负控**：把求值器换成"永远返回 declared"的假实现，同一份语料必须报错。
 * 没有这条，语料跑绿只能证明"求值器没崩"，不能证明"它真的在判"。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { BANK_TOOL_NAME_SET } from '../packages/bank/src/tools/specs.ts'
import { decide, type DecideVerdict, type TierConfig, type TierReason } from '../packages/bank/src/tools/tier.ts'
import { canonicalJson } from '../packages/util/src/index.ts'
import { loadBundle, loadRuleBundle } from '../packages/policy/src/load.ts'
import { checkRuleCases, type CompiledRuleSet } from '../packages/policy/src/sentry-rules.ts'
import { BUILTIN_RULES, scanToolArgs } from '../packages/safety/src/sentry/kernel/rules.ts'
import type { CompiledPolicy } from '../packages/policy/src/compile.ts'
import { mutateAndKill, runCorpus, type CorpusCase, type Evaluator } from '../packages/policy/src/corpus.ts'
import { describePolicyError } from '../packages/policy/src/errors.ts'
import { evaluateIr, type PolicyIr } from '../packages/policy/src/table.ts'
import type { BankTierInput, TierLevel, TierPolicyResult } from '../packages/policy/src/schema.ts'

import { isMainModule, runStandalone, type Gate, type GateResult } from './gate-lib.ts'

const REGISTRY = 'policies/registry.json'
const ORACLE_HANDLE = 'bank-tier/1.0.0'
const RISKY_CALL_THRESHOLD = 3
const CORE_DAILY_LIMIT_CENTS = 1_000_000
const LEVEL_RANK: Readonly<Record<TierLevel, number>> = { green: 0, yellow: 1, red: 2 }

/** registry 里的一个版本条目（只取门禁关心的字段）。 */
interface RegistryEntry {
  readonly kind?: string
  readonly path: string
  readonly demo?: boolean
}

const gate: Gate = {
  name: 'policy-conformance',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    const toolNames = [...BANK_TOOL_NAME_SET]

    const versions = readRegistryVersions(root, findings)
    if (versions === undefined) return { ok: false, findings, notes }

    let production = 0
    let demo = 0
    let sawOracle = false

    let sentrySets = 0
    for (const [handle, entry] of versions) {
      const dir = resolve(root, entry.path)
      const rel = relative(root, dir).replace(/\\/g, '/')
      if (!existsSync(dir)) {
        findings.push(`${handle}: registry 指向的目录不存在（${rel}）`)
        continue
      }
      if (entry.kind === 'sentry.rules') {
        try {
          const loaded = loadRuleBundle({ dir, toolNames: [], verifyLock: true })
          for (const failure of checkRuleCases(loaded.compiled)) {
            findings.push(`${rel}: ${failure}`)
          }
          checkSentryEquivalence(rel, loaded.compiled, findings)
          sentrySets += 1
        } catch (error) {
          const described = describePolicyError(error)
          findings.push(`${rel}: 编译失败 ${described.code} —— ${described.message}`)
        }
        continue
      }
      let compiled: CompiledPolicy
      let cases: readonly CorpusCase[]
      try {
        const loaded = loadBundle({ dir, toolNames, verifyLock: true, withCorpus: true })
        compiled = loaded.compiled
        cases = loaded.cases
      } catch (error) {
        const described = describePolicyError(error)
        findings.push(`${rel}: 编译失败 ${described.code} —— ${described.message}`)
        continue
      }

      checkCorpus(handle, rel, compiled, cases, findings, notes, entry.demo !== true)
      if (entry.demo === true) {
        demo += 1
        continue
      }
      checkMutations(handle, rel, compiled.ir, cases, findings)
      production += 1
      checkProperties(handle, rel, compiled, cases, findings)
      if (handle === ORACLE_HANDLE) {
        sawOracle = true
        checkEquivalence(handle, rel, compiled, findings, notes)
      }
    }

    if (!sawOracle) {
      findings.push(`registry 缺少 ${ORACLE_HANDLE}：没有生产 oracle，等价性无法证明`)
    }
    notes.push(
      `bundle：生产 ${String(production)} 个（覆盖/变异/等价全查）、演示 ${String(demo)} 个（只验用例）、` +
        `sentry 规则集 ${String(sentrySets)} 个（语料 + 旧内核等价）`,
    )
    return { ok: findings.length === 0, findings, notes }
  },
}

/**
 * `sentry.rules` 与旧内核的等价证明：13 条规则的 ID/正则/族/说明逐字一致，
 * 且每条规则的正/反例在"bundle 规则集"与"内核 13 条"下命中序列完全相同。
 */
function checkSentryEquivalence(
  rel: string,
  compiled: CompiledRuleSet,
  findings: string[],
): void {
  const external = new Map(compiled.rules.map((rule) => [rule.id, rule]))
  if (external.size !== BUILTIN_RULES.length) {
    findings.push(`${rel}: 规则条数 ${String(external.size)} 与内核 ${String(BUILTIN_RULES.length)} 不一致`)
  }
  for (const builtin of BUILTIN_RULES) {
    const found = external.get(builtin.id)
    if (found === undefined) {
      findings.push(`${rel}: 缺规则 ${builtin.id}`)
      continue
    }
    if (found.pattern.source !== builtin.pattern.source || found.pattern.flags !== builtin.pattern.flags) {
      findings.push(`${rel}: ${builtin.id} 的正则/flags 与内核不一致`)
    }
    if (found.family !== builtin.family || found.note !== builtin.note) {
      findings.push(`${rel}: ${builtin.id} 的族/说明与内核不一致`)
    }
  }
  for (const rule of compiled.ir.rules) {
    for (const text of [...rule.cases.match, ...rule.cases.nonMatch]) {
      const externalIds = scanToolArgs(text, {
        baseRules: compiled.rules,
        demoWhitelist: false,
      })
        .map((finding) => finding.id)
        .join(',')
      const kernelIds = scanToolArgs(text, { demoWhitelist: false })
        .map((finding) => finding.id)
        .join(',')
      if (externalIds !== kernelIds) {
        findings.push(
          `${rel}: ${rule.id} 的语料 "${text}" 命中不一致（bundle ${externalIds || '<none>'} vs 内核 ${kernelIds || '<none>'}）`,
        )
      }
    }
  }
}

/** 读 registry 的版本表；坏 JSON/坏形状 = 红。 */
function readRegistryVersions(
  root: string,
  findings: string[],
): ReadonlyMap<string, RegistryEntry> | undefined {
  const path = join(root, REGISTRY)
  if (!existsSync(path)) {
    findings.push(`缺 ${REGISTRY}`)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    findings.push(`${REGISTRY}: 不是合法 JSON`)
    return undefined
  }
  const kinds = (parsed as { kinds?: unknown }).kinds
  if (typeof kinds !== 'object' || kinds === null) {
    findings.push(`${REGISTRY}: kinds 必须是对象`)
    return undefined
  }
  const out = new Map<string, RegistryEntry>()
  for (const [kind, value] of Object.entries(kinds)) {
    const versions = (value as { versions?: unknown }).versions
    if (typeof versions !== 'object' || versions === null) {
      findings.push(`${REGISTRY}: kinds.${kind}.versions 必须是对象`)
      continue
    }
    for (const [handle, rawEntry] of Object.entries(versions)) {
      const entry = rawEntry as { path?: unknown; demo?: unknown }
      if (typeof entry.path !== 'string') {
        findings.push(`${REGISTRY}: ${kind}/${handle} 缺 path`)
        continue
      }
      out.set(handle, { kind, path: entry.path, ...(entry.demo === true ? { demo: true } : {}) })
    }
  }
  return out
}

/** 语料：失败逐条报、覆盖缺口逐条报，再做"假求值器必须被发现"的负控。 */
function checkCorpus(
  handle: string,
  rel: string,
  compiled: CompiledPolicy,
  cases: readonly CorpusCase[],
  findings: string[],
  notes: string[],
  full: boolean,
): void {
  const report = runCorpus(compiled.ir, cases, compiled)
  for (const failure of report.failures) {
    findings.push(
      `${rel}: 语料 ${failure.caseId} 的 ${failure.field} 不符（期望 ${failure.expected}，实际 ${failure.actual}）`,
    )
  }
  if (full) {
    for (const violation of report.coverage.violations) {
      findings.push(`${rel}: 覆盖缺口 ${violation}`)
    }
  }
  notes.push(
    `${handle}: ${String(cases.length)} 例、规则 ${String(report.coverage.rules.length)}、理由 ${String(report.coverage.reasons.length)}` +
      (full ? '' : '（demo：只验用例）'),
  )

  // 负控：求值器永远返回 declared，语料必须至少报一条 level/reason/ruleIds 差异。
  const alwaysDeclared: Evaluator = {
    evaluate: (input: BankTierInput): TierPolicyResult => ({
      level: input.action.declared,
      reason: 'declared',
      ruleIds: [],
      tables: [],
    }),
  }
  const negative = runCorpus(compiled.ir, cases, alwaysDeclared)
  if (negative.failures.length === 0) {
    findings.push(`${rel}: 负控失败——假求值器（永远 declared）仍跑绿，语料没有鉴别力`)
  }
}

/** 变异敏感性：存活变异体 / 未覆盖行都必须为 0。 */
function checkMutations(
  handle: string,
  rel: string,
  ir: PolicyIr,
  cases: readonly CorpusCase[],
  findings: string[],
): void {
  const report = mutateAndKill(ir, cases, (candidate) => ({
    evaluate: (input: BankTierInput) => evaluateIr(candidate, input),
  }))
  if (report.surviving.length > 0) {
    for (const mutant of report.surviving) {
      findings.push(`${rel}: 存活变异体 ${mutant}（语料杀不掉这条规则的改动）`)
    }
  }
  if (report.unmutated.length > 0) {
    findings.push(`${rel}: 未被变异覆盖的行 ${report.unmutated.join(', ')}`)
  }
  if (report.score < 1 && report.surviving.length === 0) {
    findings.push(`${rel}: 变异分数 ${String(report.score)}，期望 1.0`)
  }
  void handle
}

/** 属性：单调、确定、总函数、输入不被修改。 */
function checkProperties(
  handle: string,
  rel: string,
  compiled: CompiledPolicy,
  cases: readonly CorpusCase[],
  findings: string[],
): void {
  for (const item of cases) {
    const before = canonicalJson(item.input)
    let first: TierPolicyResult
    try {
      first = compiled.evaluate(compiled.validateInput(item.input))
    } catch (error) {
      findings.push(`${rel}: 属性失败——合法输入 ${item.id} 抛错（${String(error)}）`)
      continue
    }
    const after = canonicalJson(item.input)
    if (before !== after) findings.push(`${rel}: 属性失败——${item.id} 的输入被求值器修改`)
    if (LEVEL_RANK[first.level] < LEVEL_RANK[item.input.action.declared]) {
      findings.push(
        `${rel}: 属性失败——${item.id} 把 ${item.input.action.declared} 降成 ${first.level}（单调性破坏）`,
      )
    }
    const second = compiled.evaluate(compiled.validateInput(item.input))
    if (canonicalJson(first) !== canonicalJson(second)) {
      findings.push(`${rel}: 属性失败——${item.id} 两次求值不全等（不确定性）`)
    }
  }
  void handle
}

/** 穷举等价：`ORACLE_HANDLE` vs `tier.ts`。 */
function checkEquivalence(
  handle: string,
  rel: string,
  compiled: CompiledPolicy,
  findings: string[],
  notes: string[],
): void {
  const declaredLevels = ['green', 'yellow', 'red'] as const
  const plainTools = ['wealth_purchase', 'sub_cancel', 'card_report_lost', 'transfer_preview'] as const
  const configLimits = [100_000, 500_000] as const
  const riskyCounts = [0, 2, 3, 4] as const
  const previews = [
    { id: 'P1', amountCents: 0, dailyUsedCents: 0, binding: 'whitelist' as const },
    { id: 'P2', amountCents: 80_000, dailyUsedCents: 0, binding: 'whitelist' as const },
    { id: 'P3', amountCents: 80_000, dailyUsedCents: 0, binding: 'new' as const },
    { id: 'P4', amountCents: 200_000, dailyUsedCents: 300_000, binding: 'whitelist' as const },
    { id: 'P5', amountCents: 200_001, dailyUsedCents: 300_000, binding: 'whitelist' as const },
    { id: 'P6', amountCents: 600_000, dailyUsedCents: 0, binding: 'new' as const },
  ] as const

  let compared = 0
  let unbound = 0

  const legacyConfig = (dailyTransferLimitCents: number): TierConfig => ({
    dailyTransferLimitCents,
    riskyOps: ['transfer_create', 'wealth_purchase'],
    riskyCallThreshold: RISKY_CALL_THRESHOLD,
  })

  interface CaseInput {
    readonly label: string
    readonly name: string
    readonly declared: TierLevel
    readonly userId?: string
    readonly locked: boolean
    readonly risky: number
    readonly configLimit: number
    readonly preview?: {
      readonly amountCents: number
      readonly dailyUsedCents: number
      readonly dailyLimitCents: number
      readonly payee: { readonly name: string; readonly binding: 'new' | 'whitelist' }
    }
  }

  const legacyOf = (input: CaseInput): DecideVerdict =>
    decide({
      name: input.name,
      declared: input.declared,
      config: legacyConfig(input.configLimit),
      state: {
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        riskyCallsInTurn: input.risky,
        verifyLocked: input.locked,
      },
      ...(input.preview === undefined ? {} : { preview: input.preview }),
    })

  const bundleOf = (
    input: CaseInput,
    userId: string,
  ): { readonly verdict: DecideVerdict; readonly result: TierPolicyResult } => {
    const data: BankTierInput = {
      subject: { userId, sessionId: 's-conformance' },
      action: { name: input.name, declared: input.declared },
      ...(input.preview === undefined ? {} : { preview: input.preview }),
      state: { riskyCallsInTurn: input.risky, verifyLocked: input.locked },
      limits: {
        dailyLimitCents:
          input.preview === undefined
            ? input.configLimit
            : Math.min(input.preview.dailyLimitCents, input.configLimit),
      },
      params: { riskyCallThreshold: RISKY_CALL_THRESHOLD },
    }
    const result = compiled.evaluate(compiled.validateInput(data))
    const verdict = decide(
      {
        name: input.name,
        declared: input.declared,
        config: legacyConfig(input.configLimit),
        state: { userId, riskyCallsInTurn: input.risky, verifyLocked: input.locked },
        ...(input.preview === undefined ? {} : { preview: input.preview }),
      },
      { level: result.level, reason: result.reason as TierReason },
    )
    return { verdict, result }
  }

  /** 一次 bundle 求值的属性 + 确定性检查（等价域上也要成立，不只语料用例）。 */
  const checkedBundle = (input: CaseInput, userId: string): DecideVerdict => {
    const first = bundleOf(input, userId)
    if (LEVEL_RANK[first.result.level] < LEVEL_RANK[input.declared]) {
      findings.push(`${rel}: 等价域 ${input.label} 把 ${input.declared} 降成 ${first.result.level}（单调性破坏）`)
    }
    const second = bundleOf(input, userId)
    if (canonicalJson(first.result) !== canonicalJson(second.result)) {
      findings.push(`${rel}: 等价域 ${input.label} 两次求值不全等（不确定性）`)
    }
    return first.verdict
  }

  for (const declared of declaredLevels) {
    for (const userId of ['u-1', undefined] as const) {
      for (const locked of [false, true]) {
        for (const risky of riskyCounts) {
          for (const preview of previews) {
            for (const configLimit of configLimits) {
              const input: CaseInput = {
                label: `transfer_create/${declared}/${String(userId)}/locked=${String(locked)}/risky=${String(risky)}/${preview.id}/config=${String(configLimit)}`,
                name: 'transfer_create',
                declared,
                ...(userId === undefined ? {} : { userId }),
                locked,
                risky,
                configLimit,
                preview: {
                  amountCents: preview.amountCents,
                  dailyUsedCents: preview.dailyUsedCents,
                  dailyLimitCents: CORE_DAILY_LIMIT_CENTS,
                  payee: { name: '收款人', binding: preview.binding },
                },
              }
              const legacy = legacyOf(input)
              if (userId === undefined) {
                if (!isNoIdentityDeny(legacy)) {
                  findings.push(`${rel}: 等价 ${input.label}: 未绑定身份的判决不是 no-identity deny`)
                }
                unbound += 1
                continue
              }
              const bundle = checkedBundle(input, userId)
              if (canonicalJson(bundle) !== canonicalJson(legacy)) {
                findings.push(
                  `${rel}: 等价 ${input.label}: legacy=${canonicalJson(legacy)} bundle=${canonicalJson(bundle)}`,
                )
              }
              compared += 1
            }
          }
        }
      }
    }
  }

  for (const declared of declaredLevels) {
    for (const name of plainTools) {
      for (const userId of ['u-1', undefined] as const) {
        for (const locked of [false, true]) {
          for (const risky of riskyCounts) {
            for (const configLimit of configLimits) {
              const input: CaseInput = {
                label: `${name}/${declared}/${String(userId)}/locked=${String(locked)}/risky=${String(risky)}/config=${String(configLimit)}`,
                name,
                declared,
                ...(userId === undefined ? {} : { userId }),
                locked,
                risky,
                configLimit,
              }
              const legacy = legacyOf(input)
              if (userId === undefined) {
                if (!isNoIdentityDeny(legacy)) {
                  findings.push(`${rel}: 等价 ${input.label}: 未绑定身份的判决不是 no-identity deny`)
                }
                unbound += 1
                continue
              }
              const bundle = checkedBundle(input, userId)
              if (canonicalJson(bundle) !== canonicalJson(legacy)) {
                findings.push(
                  `${rel}: 等价 ${input.label}: legacy=${canonicalJson(legacy)} bundle=${canonicalJson(bundle)}`,
                )
              }
              compared += 1
            }
          }
        }
      }
    }
  }

  notes.push(
    `等价 ${handle} vs legacy：${String(compared)} 组逐字段相等、${String(unbound)} 组未绑定边界（共 ${String(compared + unbound)} 组）`,
  )
  void rel
}

function isNoIdentityDeny(verdict: DecideVerdict): boolean {
  return verdict.kind === 'deny' && verdict.code === 'no-identity'
}

if (isMainModule(import.meta.url)) await runStandalone(gate)

export { gate }
