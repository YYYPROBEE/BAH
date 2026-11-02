/**
 * `pnpm policy:lint <dir>`：只校验，不写文件（01 §10）。
 *
 * 与 `policy:compile` 的区别只在"是否关心 lock"：lint 也做 lock 比对（默认），
 * 因为"文件被就地改过"本身就是 lint 该报的问题。要生成/刷新 lock 用
 * `policy:compile --write`。
 */

import { loadBundle, loadRuleBundle, peekBundleKind } from '../packages/policy/src/load.ts'

import { fail, parseArgs, toolNames, usage } from './policy-cli.ts'

const args = parseArgs(process.argv.slice(2))
const dir = args.positional[0]

if (dir === undefined) {
  process.exitCode = usage('用法：pnpm policy:lint <bundle-dir> [--json]')
} else {
  try {
    if (peekBundleKind(dir) === 'sentry.rules') {
      const { compiled } = loadRuleBundle({ dir, toolNames: [], verifyLock: true })
      if (args.flags.has('json')) {
        console.log(
          JSON.stringify(
            { ok: true, handle: compiled.descriptor.handle, policyVersion: compiled.descriptor.policyVersion, rules: compiled.rules.length },
            null,
            2,
          ),
        )
      } else {
        console.log(`bundle    ${compiled.descriptor.policyVersion}`)
        console.log(`rules     ${String(compiled.rules.length)}`)
        console.log('✓ policy:lint 通过')
      }
      process.exitCode = 0
    } else {
    const { compiled } = loadBundle({ dir, toolNames: toolNames() })
    const ruleCount = compiled.ir.tables.reduce((sum, table) => sum + table.rows.length, 0)

    if (args.flags.has('json')) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            handle: compiled.descriptor.handle,
            policyVersion: compiled.descriptor.policyVersion,
            tables: compiled.ir.tables.length,
            rules: ruleCount,
            warnings: compiled.warnings,
          },
          null,
          2,
        ),
      )
    } else {
      console.log(`bundle    ${compiled.descriptor.policyVersion}`)
      console.log(`tables    ${String(compiled.ir.tables.length)}`)
      console.log(`rules     ${String(ruleCount)}`)
      for (const warning of compiled.warnings) {
        console.log(`warning   ${warning.code}: ${warning.message}`)
      }
      console.log('✓ policy:lint 通过')
    }
    }
  } catch (error) {
    process.exitCode = fail(error)
  }
}
