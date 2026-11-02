/**
 * `pnpm policy:compile <dir> [--write] [--check] [--json]`：编译并（可选）写 lock。
 *
 * - 默认：编译 + 与现有 `lock.json` 比对（没有 lock 就只编译，用于首次生成前自检）；
 * - `--write`：**跳过 lock 比对**，重算并写 `lock.json`（唯一会改文件的路径）；
 * - `--check`：要求 `lock.json` 存在且一致（CI 用；缺失即失败）。
 */

import {
  loadBundle,
  loadRuleBundle,
  peekBundleKind,
  writeLockFile,
  writeRuleLockFile,
} from '../packages/policy/src/load.ts'
import { policyError } from '../packages/policy/src/errors.ts'
import type { CompileResult } from '../packages/policy/src/compile.ts'
import type { SentryCompileResult } from '../packages/policy/src/sentry-rules.ts'

import { fail, parseArgs, toolNames, usage } from './policy-cli.ts'

const args = parseArgs(process.argv.slice(2))
const dir = args.positional[0]
const write = args.flags.has('write')
const check = args.flags.has('check')

if (dir === undefined) {
  process.exitCode = usage('用法：pnpm policy:compile <bundle-dir> [--write] [--check] [--json]')
} else if (write && check) {
  process.exitCode = usage('--write 与 --check 不能同时使用（一个写、一个只读）')
} else {
  try {
    const kind = peekBundleKind(dir)
    const result =
      kind === 'sentry.rules'
        ? loadRuleBundle({ dir, toolNames: [], verifyLock: !write })
        : loadBundle({ dir, toolNames: toolNames(), verifyLock: !write })

    if (write) {
      if (kind === 'sentry.rules') writeRuleLockFile(dir, (result as SentryCompileResult).lock)
      else writeLockFile(dir, (result as CompileResult).lock)
    } else if (check && !result.lockPresent) {
      // `--check` 要求 lock 必须存在：没有 lock 时"一致"是假绿。
      throw policyError('policy-digest-mismatch', 'lock.json 不存在（先跑 policy:compile --write）', {
        file: 'lock.json',
      })
    }

    if (args.flags.has('json')) {
      console.log(JSON.stringify({ ok: true, lock: result.lock }, null, 2))
    } else {
      console.log(`bundle    ${result.compiled.descriptor.policyVersion}`)
      console.log(`semantic  sha256:${result.compiled.descriptor.semanticDigest}`)
      console.log(`source    sha256:${result.compiled.descriptor.sourceDigest}`)
      console.log(write ? '✓ lock.json 已写入' : '✓ policy:compile 通过')
    }
  } catch (error) {
    process.exitCode = fail(error)
  }
}
