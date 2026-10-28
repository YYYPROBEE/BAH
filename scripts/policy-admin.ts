/**
 * 策略管理面 CLI（02 §9）：`policy:versions|install|promote|rollback|reload|audit-verify`。
 *
 * 退出码：0 成功；1 业务失败（校验/链断/无变化以外）；2 用法错误。
 * 所有写命令必须带 `--reason`（≥8 字符）并记录 operator。
 */

import { resolve } from 'node:path'

import { BahError } from '../packages/util/src/index.ts'
import { fail, usage } from './policy-cli.ts'
import {
  adminPaths,
  applyChange,
  installBundle,
  planPromote,
  planRollback,
  touchState,
  verifyRollout,
  versionsOf,
} from './policy-admin-lib.ts'

const argv = process.argv.slice(2)
const command = argv.shift()

const json = argv.includes('--json')
const paths = adminPaths({
  ...(flag('--root') === undefined ? {} : { root: flag('--root') as string }),
  ...(flag('--state') === undefined ? {} : { statePath: flag('--state') as string }),
})
const now = Date.now()
const operator = flag('--operator')
const reason = flag('--reason')

if (command === undefined) {
  process.exitCode = usage(
    '用法：pnpm policy:<versions|install|promote|rollback|reload|audit-verify> [选项]',
  )
} else {
  try {
    switch (command) {
      case 'versions': {
        const rows = versionsOf(paths)
        if (json) {
          process.stdout.write(`${JSON.stringify({ root: paths.root, statePath: paths.statePath, versions: rows }, null, 2)}\n`)
        } else {
          for (const row of rows) {
            const flags = [
              row.active ? 'active' : '',
              row.canary ? 'canary' : '',
              row.demo ? 'demo' : '',
            ]
              .filter((value) => value.length > 0)
              .join(',')
            process.stdout.write(
              `${row.kind.padEnd(10)} ${row.handle.padEnd(28)} sha256:${row.semanticDigest.slice(0, 16)}` +
                `${flags.length === 0 ? '' : `  [${flags}]`}\n`,
            )
          }
          if (rows.length === 0) process.stdout.write('（registry 里没有版本）\n')
        }
        break
      }
      case 'install': {
        const source = positional()[0]
        if (source === undefined) {
          process.exitCode = usage('用法：pnpm policy:install <bundle-dir> [--demo] [--json]')
          break
        }
        const result = installBundle({
          paths,
          sourceDir: resolve(source),
          now,
          ...(argv.includes('--demo') ? { demo: true } : {}),
        })
        if (json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        } else {
          process.stdout.write(
            `${result.changed ? '✔ 已安装' : 'ℹ 已存在同摘要版本'} ${result.handle}（sha256:${result.digest.slice(0, 16)}）\n`,
          )
        }
        break
      }
      case 'promote': {
        const to = flag('--to')
        if (to === undefined) {
          process.exitCode = usage('用法：pnpm policy:promote --to <handle> [--percent N] [--sessions a,b] [--active <handle>] --reason <text>')
          break
        }
        const plan = planPromote({
          paths,
          to,
          ...(flag('--kind') === undefined ? {} : { kind: flag('--kind') as string }),
          ...(flag('--percent') === undefined ? {} : { percent: parseInteger('--percent') }),
          ...(flag('--sessions') === undefined
            ? {}
            : { sessions: splitList(flag('--sessions') as string) }),
          ...(flag('--active') === undefined ? {} : { active: flag('--active') as string }),
          ...(operator === undefined ? {} : { operator }),
          reason: requireReason(),
          now,
        })
        applyChange(paths, plan)
        printPlan(plan, json)
        break
      }
      case 'rollback': {
        const plan = planRollback({
          paths,
          ...(flag('--kind') === undefined ? {} : { kind: flag('--kind') as string }),
          ...(flag('--to') === undefined ? {} : { to: flag('--to') as string }),
          ...(operator === undefined ? {} : { operator }),
          reason: requireReason(),
          now,
        })
        applyChange(paths, plan)
        printPlan(plan, json)
        break
      }
      case 'reload': {
        requireReason()
        const state = touchState(paths, now)
        if (json) {
          process.stdout.write(`${JSON.stringify({ updatedAt: state.updatedAt }, null, 2)}\n`)
        } else {
          process.stdout.write(`✔ 已触发重载：${paths.statePath}（updatedAt=${String(state.updatedAt)}）\n`)
        }
        break
      }
      case 'audit-verify': {
        const result = verifyRollout(paths.root)
        if (json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        } else {
          process.stdout.write(
            `${result.ok ? '✔' : '✘'} rollout 链 ${result.ok ? '连续' : `断裂@${String(result.brokenAt ?? 0)}`}（${String(result.rows)} 条）\n`,
          )
        }
        process.exitCode = result.ok ? 0 : 1
        break
      }
      default:
        process.exitCode = usage(`未知命令：${command}（versions|install|promote|rollback|reload|audit-verify）`)
    }
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

function parseInteger(name: string): number {
  const raw = flag(name)
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    throw new BahError('policy-invalid-config', `${name} 必须是整数`)
  }
  return Number.parseInt(raw, 10)
}

/** 位置参数（跳过 flag 及其值）；`install <dir>` 用它取目录。 */
function positional(): readonly string[] {
  const valued = new Set([
    '--root',
    '--state',
    '--operator',
    '--reason',
    '--kind',
    '--to',
    '--percent',
    '--sessions',
    '--active',
  ])
  return argv.filter((arg, index) => {
    if (arg.startsWith('--')) return false
    const previous = argv[index - 1]
    return previous === undefined || !valued.has(previous)
  })
}

function splitList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function requireReason(): string {
  if (reason === undefined || reason.trim().length < 8) {
    throw new BahError('policy-invalid-config', '--reason 至少 8 个字符（变更必须可追责）')
  }
  return reason
}

function printPlan(
  plan: ReturnType<typeof planPromote>,
  asJson: boolean,
): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }
  process.stdout.write(`${plan.changed ? '✔' : 'ℹ'} ${plan.summary}\n`)
  if (plan.changed) {
    process.stdout.write(
      `  链记录：${plan.record.kind} ${plan.record.from} → ${plan.record.to} ` +
        `(${String(plan.record.percent / 100)}%, epoch=${String(plan.record.epoch)}, operator=${plan.record.operator})\n`,
    )
  }
}
