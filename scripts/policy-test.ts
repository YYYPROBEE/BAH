/**
 * `pnpm policy:test <dir>`：语料 + 覆盖 + 变异（01 §10 / 04 §3）。
 *
 * 三件事缺一不可：
 * 1. 语料全绿（每条 case 的 level/reason/ruleIds/deny 都相等）；
 * 2. 覆盖无缺口（每条规则、每种理由、三档声明、两种绑定、五个边界标签）；
 * 3. 变异 100% 杀死（每条规则至少被一个变异体杀死，且没有存活变异体）。
 */

import { evaluateIr } from '../packages/policy/src/table.ts'
import { loadBundle, loadRuleBundle, peekBundleKind } from '../packages/policy/src/load.ts'
import { checkRuleCases } from '../packages/policy/src/sentry-rules.ts'
import { mutateAndKill, runCorpus, REQUIRED_TAGS } from '../packages/policy/src/corpus.ts'

import { fail, parseArgs, toolNames, usage } from './policy-cli.ts'

const args = parseArgs(process.argv.slice(2))
const dir = args.positional[0]

if (dir === undefined) {
  process.exitCode = usage('用法：pnpm policy:test <bundle-dir> [--json]')
} else {
  try {
    if (peekBundleKind(dir) === 'sentry.rules') {
      const { compiled } = loadRuleBundle({ dir, toolNames: [], verifyLock: true })
      const failures = checkRuleCases(compiled)
      const ruleCases = compiled.ir.rules.reduce(
        (sum, rule) => sum + rule.cases.match.length + rule.cases.nonMatch.length,
        0,
      )
      if (args.flags.has('json')) {
        console.log(
          JSON.stringify(
            { ok: failures.length === 0, bundle: compiled.descriptor.policyVersion, failures, rules: compiled.rules.length, cases: ruleCases },
            null,
            2,
          ),
        )
      } else {
        console.log(`bundle      ${compiled.descriptor.policyVersion}`)
        console.log(`rules       ${String(compiled.rules.length)}`)
        console.log(`cases       ${String(ruleCases)}`)
        for (const failure of failures) console.log(`failure     ${failure}`)
        console.log(failures.length === 0 ? '✓ policy:test 通过' : '✘ 语料失败')
      }
      process.exitCode = failures.length === 0 ? 0 : 1
    } else {
      const { compiled, cases } = loadBundle({ dir, toolNames: toolNames() })
    const report = runCorpus(compiled.ir, cases, compiled)
    const mutation = mutateAndKill(compiled.ir, cases, (candidate) => ({
      evaluate: (input) => evaluateIr(candidate, input),
    }))

    const ok =
      report.failures.length === 0 &&
      report.coverage.violations.length === 0 &&
      mutation.surviving.length === 0 &&
      mutation.unmutated.length === 0 &&
      mutation.score === 1

    if (args.flags.has('json')) {
      console.log(
        JSON.stringify(
          {
            ok,
            bundle: compiled.descriptor.policyVersion,
            failures: report.failures,
            coverage: report.coverage,
            mutation,
          },
          null,
          2,
        ),
      )
    } else {
      const { coverage } = report
      const rules = compiled.ir.tables.flatMap((table) => table.rows.map((row) => row.id))
      console.log(`bundle      ${compiled.descriptor.policyVersion}`)
      console.log(`rules       ${String(coverage.rules.length)}/${String(rules.length)} (${rules.join(', ')})`)
      console.log(`reasons     ${String(coverage.reasons.length)}/${String(compiled.ir.reasons.length)} (${coverage.reasons.join(', ')})`)
      const actions = Object.entries(coverage.actions)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([kind, count]) => `${kind} ${String(count)}`)
      console.log(`actions     ${actions.length === 0 ? '0' : actions.join(', ')}`)
      const boundaries = REQUIRED_TAGS.map((tag) => `${tag} ${String(coverage.tagCounts[tag] ?? 0)}`)
      console.log(`boundary    ${boundaries.join(', ')}`)
      console.log(`cases       ${String(coverage.cases)}`)
      console.log(
        `mutants     ${String(mutation.killed)}/${String(mutation.total)} killed (${(mutation.score * 100).toFixed(1)}%)`,
      )

      for (const failure of report.failures) {
        console.error(
          `✘ ${failure.caseId} ${failure.field}: 期望 ${failure.expected}，实际 ${failure.actual}`,
        )
      }
      for (const violation of coverage.violations) console.error(`✘ 覆盖缺口 ${violation}`)
      for (const survivor of mutation.surviving) console.error(`✘ 存活变异体 ${survivor}`)
      for (const row of mutation.unmutated) console.error(`✘ 未生成变异体 ${row}`)

      console.log(ok ? '✓ policy:test 通过' : '✘ policy:test 未通过')
    }

    if (!ok) process.exitCode = 1
    }
  } catch (error) {
    process.exitCode = fail(error)
  }
}
