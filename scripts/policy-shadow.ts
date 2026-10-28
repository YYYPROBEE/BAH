/**
 * `pnpm policy:shadow --from <handle> --to <handle> --sessions <dir>`（02 §7.2）：
 * 用**真实判决证据**重放候选版本，输出差异清单。
 *
 * 只读：不改 state、不写链、不启动 host。退出码 1 = 有未解释差异（灰度前硬门禁）。
 */

import { fail, usage } from './policy-cli.ts'
import { adminPaths, compareShadow } from './policy-admin-lib.ts'

const argv = process.argv.slice(2)
const from = flag('--from')
const to = flag('--to')
const sessionsDir = flag('--sessions')
const asJson = argv.includes('--json')
const paths = adminPaths({
  ...(flag('--root') === undefined ? {} : { root: flag('--root') as string }),
  ...(flag('--state') === undefined ? {} : { statePath: flag('--state') as string }),
})

if (from === undefined || to === undefined || sessionsDir === undefined) {
  process.exitCode = usage(
    '用法：pnpm policy:shadow --from <handle> --to <handle> --sessions <dir> [--json]',
  )
} else {
  try {
    const report = compareShadow({ paths, from, to, sessionsDir })
    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      process.stdout.write(
        `shadow ${from} → ${to}: changed ${String(report.changed)}/${String(report.total)}` +
          `（skipped legacy=${String(report.skipped)}）\n`,
      )
      for (const diff of report.diffs) {
        process.stdout.write(`  - ${diff.session}/${diff.callId}: ${diff.fields.join(', ')}\n`)
      }
    }
    process.exitCode = report.changed === 0 ? 0 : 1
  } catch (error) {
    process.exitCode = fail(error)
  }
}

function flag(name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
