/**
 * 本地等价 CI（BAH 代码修改清单 2026-10-20 · B1.3）。
 *
 * 与旧版的三处关键差别：
 * 1. 增加 `build` 与 `rag:check`；e2e 无密钥时记为 **skipped**，不再显示“全部通过”；
 * 2. 每个测试面跑完读 JSON/JUnit 报告，断言最小用例数与 0 skip（删测试/大面积 skip 直接红）；
 * 3. 主动设置 `BAH_SNAPSHOT_BASE`：CI 没有基线就失败，本地回退到 HEAD。
 *
 * 纪律：
 * - 子进程 `stdio: 'inherit'`——不捕获输出（受限环境下捕获管道会 EPERM）；
 * - 测试计数通过 vitest `--outputFile.json` / pytest `--junitxml` 落盘读取，不抓管道；
 * - **fail-fast**：先修第一个红的。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

/** 仓库根：本文件位于 `<root>/scripts/`。 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifacts = join(root, '.ci-artifacts')

type OutcomeStatus = 'passed' | 'failed' | 'skipped'

interface Outcome {
  readonly name: string
  readonly ms: number
  readonly status: OutcomeStatus
  readonly detail?: string
}

interface CommandStep {
  readonly kind: 'command'
  readonly name: string
  readonly command: string
}

interface VitestStep {
  readonly kind: 'vitest'
  readonly name: string
  readonly config?: string
  readonly coverage?: boolean
  readonly minCases: number
}

interface E2eStep {
  readonly kind: 'e2e'
  readonly name: string
}

interface RagStep {
  readonly kind: 'rag'
  readonly name: string
  readonly minCases: number
}

type Step = CommandStep | VitestStep | E2eStep | RagStep

/**
 * 用例地板：取实测值**减少量余量**，任何一条被删即红。
 *
 * 2026-10-27 C2 抬地板：旧值（unit 1570 / snapshot 14 / web 52）是 10-24 的实测，
 * 此后 W17–W20 与 §5.1/§5.2 修复加了两百多例，地板却没跟上——**删掉一整个测试文件
 * 仍会绿**，那条"删测试即红"的判据实际上早已失效。
 *
 * 现值：unit 实测 2830（地板 2829，移动 H5 01 收口抬）、snapshot 实测 34（地板 22）、
 * web 实测 333（地板 332，移动 H5 02 收口抬：新增 apps/web/src/mobile 10 文件 / 194 例）。
 * snapshot 地板是历史值，只增不减。
 * 余量刻意留小：地板的作用是钉住"没有大批丢失"，不是允许慢慢删。
 */
const STEPS: readonly Step[] = [
  { kind: 'command', name: 'typecheck', command: 'pnpm typecheck' },
  { kind: 'command', name: 'lint', command: 'pnpm lint' },
  { kind: 'command', name: 'build', command: 'pnpm build' },
  { kind: 'vitest', name: 'test (unit)', minCases: 3046 },
  { kind: 'vitest', name: 'test:coverage', coverage: true, minCases: 3046 },
  // W17：全仓覆盖率口径（分母 = packages/*/src 全量，不是 allowlist 名单）。
  // 上一步的 `test:coverage` 守"名单内逐文件 100%"，这一步报"全仓行口径 ≥80% / 包口径 ≥14/16"。
  // 两步都要：只有前者会"分母只算一半"，只有后者会丢掉"确定性组件必须 100%"的硬约束。
  { kind: 'command', name: 'test:coverage:all', command: 'pnpm test:coverage:all' },
  { kind: 'command', name: 'gate', command: 'pnpm gate' },
  // W15：eval 三步接线（unit / smoke / baseline）；都走真实 boot，不进主 vitest 面。
  { kind: 'command', name: 'eval:unit', command: 'pnpm eval:unit' },
  { kind: 'command', name: 'eval:smoke', command: 'pnpm eval:smoke' },
  { kind: 'command', name: 'eval:baseline', command: 'pnpm eval:baseline' },
  { kind: 'e2e', name: 'test:e2e' },
  { kind: 'vitest', name: 'test:snapshot', config: 'vitest.snapshot.config.ts', minCases: 38 },
  { kind: 'vitest', name: 'test:web', config: 'vitest.web.config.ts', minCases: 337 },
  { kind: 'rag', name: 'rag:check', minCases: 75 },
]

/** e2e 需要真实密钥；缺失时明确 SKIP。 */
const hasE2eKey = Boolean(process.env['DEEPSEEK_API_KEY'])

/**
 * 严格模式（`--ci`）：未执行面不得算通过。
 *
 * 与 `CI` 环境变量**刻意分开**：后者还额外要求显式 `BAH_SNAPSHOT_BASE`
 * （见 resolveSnapshotBase），本地用 `CI=true` 会先卡在快照基线、一步都跑不到，
 * 于是"无 key 即红"这条语义根本得不到验证。两者职责不同，不可混用。
 */
const strictMode = process.argv.includes('--ci')

const outcomes: Outcome[] = []
let blocked = false

rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const snapshotBase = resolveSnapshotBase()
if (snapshotBase === undefined) {
  console.error(
    'BAH CI · 无法解析 BAH_SNAPSHOT_BASE：CI 必须显式提供基线（否则快照门禁拒绝默认通过）',
  )
  process.exitCode = 1
} else {
  console.log(`BAH CI · ${STEPS.length} 步（cwd=${root}）`)
  console.log(`BAH CI · snapshot base = ${snapshotBase}\n`)

  for (const [index, step] of STEPS.entries()) {
    console.log(`▶ [${index + 1}/${STEPS.length}] ${step.name}`)
    const startedAt = performance.now()
    const outcome = runStep(step, String(index))
    const ms = Math.round(performance.now() - startedAt)
    outcomes.push({ ...outcome, ms })
    printOutcome({ ...outcome, ms })
    if (outcome.status === 'failed') {
      blocked = true
      break
    }
  }

  console.log('\nBAH CI · 汇总')
  for (const outcome of outcomes) {
    const mark = outcome.status === 'passed' ? '✔' : outcome.status === 'skipped' ? '○' : '✘'
    const detail = outcome.detail === undefined ? '' : `  ${outcome.detail}`
    console.log(`${mark} ${outcome.name.padEnd(16)} ${String(outcome.ms).padStart(6)}ms${detail}`)
  }

  const notRun = STEPS.length - outcomes.length
  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  if (blocked) {
    console.error(`\n阻断合并：${failed.length} 步失败${notRun > 0 ? `（后续 ${notRun} 步未执行）` : ''}`)
    process.exitCode = 1
  } else {
    const skipped = outcomes.filter((outcome) => outcome.status === 'skipped')
    if (skipped.length === 0) {
      console.log('\n全部通过')
    } else if (strictMode) {
      // 严格模式：有面没跑，不得算绿——这是"CI 不撒谎"的唯一判据。
      console.error(
        `\n阻断合并：${skipped.length} 步未执行（${skipped.map((item) => item.name).join(', ')}）` +
          '——严格模式不接受 SKIP',
      )
      process.exitCode = 1
    } else {
      console.log(
        `\n通过 ${outcomes.length - skipped.length} 步，未执行面 ${skipped.map((item) => item.name).join(', ')}` +
          '（本地模式不计为失败；严格模式见 `pnpm check:ci`）',
      )
    }
  }
}

/** 执行一步；返回原始结果（耗时由调用方补）。 */
function runStep(step: Step, index: string): Omit<Outcome, 'ms'> {
  switch (step.kind) {
    case 'command':
      return runCommand(step.name, step.command)
    case 'vitest':
      return runVitest(step, index)
    case 'e2e':
      return runE2e(index)
    case 'rag':
      return runRag(step, index)
  }
}

function runCommand(name: string, command: string): Omit<Outcome, 'ms'> {
  const result = spawnSync(command, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: childEnv(),
  })
  return {
    name,
    status: result.status === 0 ? 'passed' : 'failed',
    ...(result.status === 0 ? {} : { detail: `exit ${String(result.status)}` }),
  }
}

function runVitest(step: VitestStep, index: string): Omit<Outcome, 'ms'> {
  const report = join(artifacts, `vitest-${index}.json`)
  const args = [
    'exec',
    'vitest',
    'run',
    ...(step.config === undefined ? [] : ['--config', step.config]),
    ...(step.coverage === true ? ['--coverage'] : []),
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${quote(report)}`,
  ]
  const result = spawnSync(`pnpm ${args.join(' ')}`, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: childEnv(),
  })
  if (result.status !== 0) {
    return { name: step.name, status: 'failed', detail: `exit ${String(result.status)}` }
  }
  const counts = readVitestCounts(report)
  if (counts === undefined) {
    return { name: step.name, status: 'failed', detail: '缺少 JSON 报告（无法证明用例数）' }
  }
  if (counts.failed > 0) {
    return { name: step.name, status: 'failed', detail: `${counts.failed} failed` }
  }
  if (counts.total < step.minCases) {
    return {
      name: step.name,
      status: 'failed',
      detail: `${counts.total} < min ${step.minCases}`,
    }
  }
  if (counts.pending > 0) {
    return { name: step.name, status: 'failed', detail: `${counts.pending} skipped（除 e2e 外不允许）` }
  }
  return { name: step.name, status: 'passed', detail: `${counts.total} tests` }
}

function runE2e(index: string): Omit<Outcome, 'ms'> {
  if (!hasE2eKey) {
    if (process.env['BAH_REQUIRE_E2E'] === '1') {
      return {
        name: 'test:e2e',
        status: 'failed',
        detail: 'BAH_REQUIRE_E2E=1 但没有 DEEPSEEK_API_KEY',
      }
    }
    return { name: 'test:e2e', status: 'skipped', detail: 'SKIP (no DEEPSEEK_API_KEY)' }
  }

  const report = join(artifacts, `vitest-e2e-${index}.json`)
  const command = `pnpm exec vitest run --config vitest.e2e.config.ts --reporter=default --reporter=json --outputFile.json=${quote(report)}`
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true, env: childEnv() })
  if (result.status !== 0) {
    return { name: 'test:e2e', status: 'failed', detail: `exit ${String(result.status)}` }
  }
  const counts = readVitestCounts(report)
  if (counts === undefined) {
    return { name: 'test:e2e', status: 'failed', detail: '缺少 JSON 报告' }
  }
  if (counts.total === 0) {
    return { name: 'test:e2e', status: 'failed', detail: '有密钥但零用例（不算通过）' }
  }
  if (counts.failed > 0) {
    return { name: 'test:e2e', status: 'failed', detail: `${counts.failed} failed` }
  }
  return { name: 'test:e2e', status: 'passed', detail: `${counts.total} tests` }
}

function runRag(step: RagStep, index: string): Omit<Outcome, 'ms'> {
  const report = join(artifacts, `rag-${index}.xml`)
  const command = `node scripts/rag.mjs check --junitxml=${quote(report)}`
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true, env: childEnv() })
  if (result.status !== 0) {
    return { name: step.name, status: 'failed', detail: `exit ${String(result.status)}` }
  }
  const counts = readJUnitCounts(report)
  if (counts === undefined) {
    return { name: step.name, status: 'failed', detail: '缺少 JUnit 报告（无法证明用例数）' }
  }
  if (counts.failures > 0 || counts.errors > 0) {
    return {
      name: step.name,
      status: 'failed',
      detail: `${counts.failures} failures / ${counts.errors} errors`,
    }
  }
  if (counts.tests < step.minCases) {
    return {
      name: step.name,
      status: 'failed',
      detail: `${counts.tests} < min ${step.minCases}`,
    }
  }
  if (counts.skipped > 0) {
    return { name: step.name, status: 'failed', detail: `${counts.skipped} skipped` }
  }
  return { name: step.name, status: 'passed', detail: `${counts.tests} tests` }
}

/**
 * 解析快照基线。
 *
 * CI：必须显式提供 `BAH_SNAPSHOT_BASE`（workflow 从 PR base / push before 取）。
 * 本地：origin/main 的 merge-base → HEAD（提交前工作树）。
 */
function resolveSnapshotBase(): string | undefined {
  const explicit = process.env['BAH_SNAPSHOT_BASE']
  if (explicit !== undefined && explicit.trim().length > 0) return explicit

  const isCi = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true'
  if (isCi) return undefined

  const origin = spawnSync('git', ['rev-parse', '--verify', 'origin/main'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (origin.status === 0) {
    const merge = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    })
    if (merge.status === 0 && merge.stdout.trim().length > 0) return merge.stdout.trim()
    return 'origin/main'
  }

  return 'HEAD'
}

/** 子进程环境：显式带快照基线。 */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(snapshotBase === undefined ? {} : { BAH_SNAPSHOT_BASE: snapshotBase }),
  }
}

function readVitestCounts(path: string): { total: number; failed: number; pending: number } | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const total = numberField(record, 'numTotalTests')
    const failed = numberField(record, 'numFailedTests')
    const pending = numberField(record, 'numPendingTests')
    if (total === undefined || failed === undefined || pending === undefined) return undefined
    return { total, failed, pending }
  } catch {
    return undefined
  }
}

function readJUnitCounts(
  path: string,
): { tests: number; failures: number; errors: number; skipped: number } | undefined {
  if (!existsSync(path)) return undefined
  try {
    const xml = readFileSync(path, 'utf8')
    const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)]
    if (suites.length === 0) return undefined
    const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 }
    for (const matched of suites) {
      const attrs = matched[1] ?? ''
      totals.tests += attrNumber(attrs, 'tests')
      totals.failures += attrNumber(attrs, 'failures')
      totals.errors += attrNumber(attrs, 'errors')
      totals.skipped += attrNumber(attrs, 'skipped')
    }
    return totals
  } catch {
    return undefined
  }
}

function attrNumber(attrs: string, name: string): number {
  const matched = new RegExp(`${name}="(\\d+)"`).exec(attrs)
  return matched === null ? 0 : Number(matched[1])
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** shell 里给含空格/中文的路径加引号（Windows cmd 与 POSIX 都接受双引号）。 */
function quote(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`
}

/** 打印单步结论（测试计数/跳过原因）。 */
function printOutcome(outcome: Outcome): void {
  const mark = outcome.status === 'passed' ? '✔' : outcome.status === 'skipped' ? '○' : '✘'
  const detail = outcome.detail === undefined ? '' : ` —— ${outcome.detail}`
  console.log(`${mark} ${outcome.name}${detail}\n`)
}
