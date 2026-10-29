/**
 * 把历史平铺的会话目录搬进租户根（租户与鉴权 01 · TA-12）。
 *
 * ## 为什么需要迁移
 *
 * 租户化之前会话是平铺的：`sessions/<sessionId>/session.jsonl`。租户化之后是
 * `sessions/<tenant>/<sessionId>/session.jsonl`（`core:persistence` 的 `SessionFiles.root`
 * 变成租户根）。**新代码不会再去读平铺目录**，所以旧目录不搬 = 历史会话与审计链
 * 对 `bah audit --tenant demo` 不可见（"扫不到 = 没问题"）。
 *
 * ## 纪律
 *
 * 1. **默认 dry-run**：只打印计划，`--apply` 才动文件；
 * 2. **不覆盖**：目标已存在时跳过并报出来（不猜"哪个才对"）；
 * 3. **幂等**：跑两次，第二次 `moved=0`；
 * 4. **只搬会话目录**：判定标准是"目录里直接有 `session.jsonl` 或 `audit.jsonl`"。
 *    `saga.sqlite` / `memory.db` / `anchors.json` 是**文件**，不在迁移面内
 *    （saga 库按 01 §5 不按租户分库；记忆库是租户化之后才有的，本来就在正确位置）。
 *
 * 用法：
 * ```
 * npx tsx scripts/migrate-tenant-layout.ts                  # 计划（默认 sessions/ → demo）
 * npx tsx scripts/migrate-tenant-layout.ts --apply          # 执行
 * npx tsx scripts/migrate-tenant-layout.ts --root other --tenant acme-bank
 * ```
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { DEFAULT_TENANT_ID, isTenantId } from '../packages/util/src/index.ts'

import { isMainModule } from './gate-lib.ts'

/** 一个待处理项。 */
export interface MigrationEntry {
  readonly name: string
  readonly from: string
  readonly to: string
  /** `move` = 会搬；`skip-exists` = 目标已存在，跳过（不覆盖）。 */
  readonly action: 'move' | 'skip-exists'
}

/** 迁移计划（dry-run 的产物）。 */
export interface MigrationPlan {
  readonly root: string
  readonly tenant: string
  readonly entries: readonly MigrationEntry[]
}

/** 执行结果。 */
export interface MigrationResult {
  readonly moved: number
  readonly skipped: number
}

/** 目录里直接有会话日志或审计链（= 一个旧式平铺的会话目录）。 */
function isSessionDir(path: string): boolean {
  return existsSync(join(path, 'session.jsonl')) || existsSync(join(path, 'audit.jsonl'))
}

/**
 * 算出迁移计划（**纯读取**，不产生任何写入）。
 *
 * @param root 部署根（如 `sessions`）
 * @param tenant 目标租户（搬进 `<root>/<tenant>/`）
 */
export function planMigration(root: string, tenant: string): MigrationPlan {
  if (!isTenantId(tenant)) {
    throw new Error(`migrate-tenant-layout: 非法租户 ID ${JSON.stringify(tenant)}`)
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { root, tenant, entries: [] }
  }
  const entries: MigrationEntry[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // 租户目录本身不搬（它下面没有 session.jsonl，这里再显式挡一次）
    if (!entry.isDirectory() || entry.name === tenant) continue
    const from = join(root, entry.name)
    if (!isSessionDir(from)) continue
    const to = join(root, tenant, entry.name)
    entries.push({ name: entry.name, from, to, action: existsSync(to) ? 'skip-exists' : 'move' })
  }
  return { root, tenant, entries: entries.sort((left, right) => left.name.localeCompare(right.name)) }
}

/**
 * 执行计划。
 *
 * 只 `renameSync`：同盘移动是原子的，不会出现"半个会话目录"。
 */
export function applyMigration(plan: MigrationPlan): MigrationResult {
  let moved = 0
  let skipped = 0
  for (const entry of plan.entries) {
    if (entry.action === 'skip-exists') {
      skipped += 1
      continue
    }
    mkdirSync(dirname(entry.to), { recursive: true })
    renameSync(entry.from, entry.to)
    moved += 1
  }
  return { moved, skipped }
}

/** 人读计划。 */
export function renderPlan(plan: MigrationPlan): string {
  const lines = [`migrate-tenant-layout: 根 ${plan.root} → 租户 ${plan.tenant}（共 ${String(plan.entries.length)} 项）`]
  for (const entry of plan.entries) {
    if (entry.action === 'skip-exists') {
      lines.push(`  跳过（目标已存在，不覆盖）：${entry.from} → ${entry.to}`)
    } else {
      lines.push(`  待迁移：${entry.from} → ${entry.to}`)
    }
  }
  if (plan.entries.length === 0) lines.push('  （没有需要迁移的会话目录）')
  return lines.join('\n')
}

/** 解析 argv（失败返回一行理由）。 */
function parseArgs(argv: readonly string[]):
  | { readonly ok: true; readonly root: string; readonly tenant: string; readonly apply: boolean; readonly help: boolean }
  | { readonly ok: false; readonly error: string } {
  let root = 'sessions'
  let tenant: string = DEFAULT_TENANT_ID
  let apply = false
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] as string
    const separator = raw.indexOf('=')
    const flag = separator > 0 ? raw.slice(0, separator) : raw
    const inline = separator > 0 ? raw.slice(separator + 1) : undefined
    const value = (): string | undefined => {
      const candidate = inline ?? argv[index + 1]
      if (candidate === undefined || candidate.length === 0) return undefined
      if (inline === undefined) index += 1
      return candidate
    }
    switch (flag) {
      case '--root': {
        const read = value()
        if (read === undefined) return { ok: false, error: '--root 需要一个值' }
        root = read
        break
      }
      case '--tenant': {
        const read = value()
        if (read === undefined) return { ok: false, error: '--tenant 需要一个值' }
        if (!isTenantId(read)) return { ok: false, error: `--tenant 的值不是合法租户 ID：${read}` }
        tenant = read
        break
      }
      case '--apply':
        apply = true
        break
      case '-h':
      case '--help':
        help = true
        break
      default:
        return { ok: false, error: `未知参数 ${raw}` }
    }
  }
  return { ok: true, root, tenant, apply, help }
}

const HELP = [
  'migrate-tenant-layout —— 把平铺的会话目录搬进租户根（01 TA-12）',
  '',
  '用法：npx tsx scripts/migrate-tenant-layout.ts [--root sessions] [--tenant demo] [--apply]',
  '',
  '  --root <dir>   部署根（缺省 sessions）',
  '  --tenant <id>  目标租户（缺省 demo）',
  '  --apply        真的动文件（缺省只打印计划）',
].join('\n')

/** 脚本入口。 */
function main(): number {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(`migrate-tenant-layout: ${parsed.error}`)
    console.error(HELP)
    return 2
  }
  if (parsed.help) {
    console.log(HELP)
    return 0
  }
  const plan = planMigration(resolve(parsed.root), parsed.tenant)
  console.log(renderPlan(plan))
  if (!parsed.apply) {
    console.log('（dry-run：什么都没动；加 --apply 执行）')
    return 0
  }
  const result = applyMigration(plan)
  console.log(`完成：moved=${String(result.moved)} skipped=${String(result.skipped)}`)
  return 0
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main()
}
