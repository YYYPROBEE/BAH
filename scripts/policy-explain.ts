/**
 * `pnpm policy:explain --session <id> --dir <tenant-sessions> [--call-id <id>|--seq <n>]`
 * （02 §5.2）：按记录里的 digest 找归档 bundle，复算同一条判决。
 * `<tenant-sessions>` 是**租户目录**（`<deploy>/<tenant>`），不是部署根。
 *
 * 纯读：不改 state、不写链、不启动 host。实现与排版在 `policy-explain-lib.ts`。
 */

import { BahError } from '../packages/util/src/index.ts'

import { fail, usage } from './policy-cli.ts'
import { adminPaths } from './policy-admin-lib.ts'
import { explainDecision, printExplain } from './policy-explain-lib.ts'

const argv = process.argv.slice(2)
const session = flag('--session')
const dir = flag('--dir')
const callId = flag('--call-id')
const seq = flag('--seq')
const asJson = argv.includes('--json')
const requireChain = argv.includes('--require-chain')
const requireEvidence = argv.includes('--require-evidence')
const paths = adminPaths({
  ...(flag('--root') === undefined ? {} : { root: flag('--root') as string }),
  ...(flag('--state') === undefined ? {} : { statePath: flag('--state') as string }),
})

if (session === undefined || dir === undefined || (callId === undefined && seq === undefined)) {
  process.exitCode = usage(
    '用法：pnpm policy:explain --session <id> --dir <tenant-sessions> [--call-id <id>|--seq <n>] [--json] [--require-chain] [--require-evidence]',
  )
} else {
  try {
    const result = explainDecision({
      session,
      sessionsDir: dir,
      ...(callId === undefined ? {} : { callId }),
      ...(seq === undefined ? {} : { seq: parseSeq(seq) }),
      paths,
      requireChain,
      requireEvidence,
    })
    process.stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : printExplain(result))
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    process.exitCode = fail(error)
  }
}

function parseSeq(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new BahError('policy-invalid-config', '--seq 必须是非负整数')
  }
  return Number.parseInt(raw, 10)
}

function flag(name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
