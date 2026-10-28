/**
 * 对抗集 runner（W14）：复用 W13 的 boot/场景执行，输出攻击面报告。
 *
 * 报告口径：
 * - `handled` = 该例的期望被满足（拦截 / 拒答 / 降级）；
 * - 分母**排除** `[unverified]` 外部样本（TC-W14-07）；
 * - 未拦的每一例必须带归因（`model-layer` / `deps-missing` / `rule-gap`）。
 */

import { runEval } from '../scenario/runner.ts'
import type { EvalTiming } from '../scenario/runner.ts'
import { familyLabel, metaOf, validateAdversarial } from './expected.ts'
import type { AdversarialAttribution, AdversarialExpectation, AdversarialFamily, AdversarialMeta } from './expected.ts'
import { HALLUCINATION_SCENARIOS } from './hallucination/index.ts'
import { INJECTION_SCENARIOS } from './injection/index.ts'
import { PRIVILEGE_SCENARIOS } from './privilege/index.ts'

const ADVERSARIAL_SCENARIOS = [
  ...INJECTION_SCENARIOS,
  ...PRIVILEGE_SCENARIOS,
  ...HALLUCINATION_SCENARIOS,
] as const

const FAMILY_ORDER: readonly AdversarialFamily[] = ['I', 'P', 'H']

/** 单例结果。 */
export interface AdversarialCaseResult extends AdversarialMeta {
  /** 期望是否被满足。 */
  readonly status: 'pass' | 'fail'
  /** 实际结果：blocked / refused / degraded / allowed。 */
  readonly actual: 'blocked' | 'refused' | 'degraded' | 'allowed'
  readonly code?: string
  readonly detail?: string
  /** 未拦时的归因（仅 `status=fail`）。 */
  readonly attribution?: AdversarialAttribution
}

/** 族级比率（分母已排除 unverified）。 */
export interface AdversarialRate {
  readonly handled: number
  readonly total: number
}

/** 对抗报告。 */
export interface AdversarialReport {
  readonly schemaVersion: 'adversarial-report.v1'
  readonly cases: readonly AdversarialCaseResult[]
  readonly families: Readonly<Record<AdversarialFamily, AdversarialRate>>
  readonly overall: AdversarialRate
  /** `[unverified]` 样本数（不进分母）。 */
  readonly unverified: number
  /** 本次实际 boot 次数（全量 4：注入 / 越权 reject / 越权 unavailable / 幻觉；smoke 3）。 */
  readonly bootCount: number
  /** 报告里是否只跑了 smoke 子集。 */
  readonly smoke: boolean
}

/** 一次对抗运行结果。 */
export interface AdversarialRunResult {
  readonly report: AdversarialReport
  readonly timing: EvalTiming
}

/** 跑对抗集。 */
export async function runAdversarial(options: {
  readonly repoRoot: string
  readonly smoke?: boolean
  readonly shard?: number
}): Promise<AdversarialRunResult> {
  const validation = validateAdversarial(ADVERSARIAL_SCENARIOS)
  if (!validation.ok) {
    throw new Error(`对抗集校验失败：\n${validation.findings.join('\n')}`)
  }
  const scenarios =
    options.smoke === true
      ? ADVERSARIAL_SCENARIOS.filter((scenario) => {
          const ordinal = Number(scenario.spec.id.slice(2))
          return ordinal <= 3
        })
      : ADVERSARIAL_SCENARIOS
  const run = await runEval({
    repoRoot: options.repoRoot,
    scenarios,
    validate: false,
    writeArtifacts: false,
    shard: options.shard ?? 3,
  })
  const outcomes = new Map(run.report.scenarios.map((outcome) => [outcome.id, outcome]))
  const cases: AdversarialCaseResult[] = scenarios.map((scenario) => {
    const meta = metaOf(scenario.spec.id)
    const outcome = outcomes.get(scenario.spec.id)
    const pass = outcome?.status === 'pass'
    return {
      ...meta,
      status: pass ? 'pass' : 'fail',
      actual: pass ? actualOf(meta.expectation) : 'allowed',
      ...(outcome?.code === undefined ? {} : { code: outcome.code }),
      ...(outcome?.detail === undefined ? {} : { detail: outcome.detail }),
      ...(pass ? {} : { attribution: meta.attributionIfMissed ?? 'rule-gap' }),
    }
  })

  const families = {} as Record<AdversarialFamily, AdversarialRate>
  for (const family of FAMILY_ORDER) {
    const items = cases.filter((item) => item.family === family && item.source.verified)
    families[family] = {
      handled: items.filter((item) => item.status === 'pass').length,
      total: items.length,
    }
  }
  const counted = cases.filter((item) => item.source.verified)
  const report: AdversarialReport = {
    schemaVersion: 'adversarial-report.v1',
    cases,
    families,
    overall: {
      handled: counted.filter((item) => item.status === 'pass').length,
      total: counted.length,
    },
    unverified: cases.filter((item) => !item.source.verified).length,
    bootCount: run.report.bootCount,
    smoke: options.smoke === true,
  }
  return { report, timing: run.timing }
}

/** 人读摘要（族级拦截率 + 未拦归因）。 */
export function renderAdversarialSummary(report: AdversarialReport): string {
  const lines: string[] = [
    '# 对抗集摘要（W14）',
    '',
    `- 样本：${String(report.cases.length)} 例（${report.smoke ? 'smoke 子集' : '全量'}）；` +
      `分母 ${String(report.overall.total)}（排除 [unverified] ${String(report.unverified)} 例）`,
    `- 总拦截率：${formatRate(report.overall)}`,
    '',
    '| 族 | 处理 | 拦截率 |',
    '|---|---|---|',
    ...FAMILY_ORDER.map(
      (family) => `| ${familyLabel(family)} | ${formatRate(report.families[family])} | ${pct(report.families[family])} |`,
    ),
    '',
    '## 未拦样本（含归因）',
    '',
  ]
  const missed = report.cases.filter((item) => item.status === 'fail')
  if (missed.length === 0) {
    lines.push('无')
  } else {
    lines.push('| ID | 期望 | 实际 | 归因 | 详情 |', '|---|---|---|---|---|')
    for (const item of missed) {
      lines.push(
        `| ${item.id} | ${item.expectation} | ${item.actual} | ${item.attribution ?? '?'} | ${(item.detail ?? '').replace(/\|/g, '\\|')} |`,
      )
    }
  }
  lines.push('', '## 来源', '')
  for (const item of report.cases) {
    const ref = item.source.kind === 'self' ? '自编' : (item.source.ref ?? '')
    const mark = item.source.verified ? '' : ' [unverified]'
    lines.push(`- ${item.id}：${item.source.kind === 'self' ? '自编' : ref}${mark}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** 期望 → 实际类别（仅当该例通过时使用）。 */
function actualOf(expectation: AdversarialExpectation): 'blocked' | 'refused' | 'degraded' {
  switch (expectation) {
    case 'block':
      return 'blocked'
    case 'refuse':
      return 'refused'
    case 'degrade':
      return 'degraded'
    default:
      return 'degraded'
  }
}

function formatRate(rate: AdversarialRate): string {
  return `${String(rate.handled)}/${String(rate.total)}`
}

function pct(rate: AdversarialRate): string {
  return rate.total === 0 ? 'n/a' : `${((rate.handled / rate.total) * 100).toFixed(1)}%`
}
