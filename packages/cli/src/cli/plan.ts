/**
 * `bah plan`：计划域的命令行入口（G1/G2 的运维面）。
 *
 * 四个子命令：
 * - `list`   列出授权窗口（只读）；
 * - `wake`   扫到期计划并执行（`--at` 只改**判定时刻**，落账时刻仍是真时间）；
 * - `arm`    从 JSON 文件签发授权窗口（走工具管线：需要人工审批，票据链完整）；
 * - `disarm` 撤销授权窗口（同上）。
 *
 * 为什么 arm/disarm 也走管线而不是直接调 store：绕过去就没有 `tool/call` + `tool/result`，
 * 回放会丢掉这条窗口——"CLI 干的事审计看不见"是不可接受的。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { boot, createCatalog } from '@bah/host'
import { SESSION_SERVICE, TOOLS_SERVICE, ToolGuard, ToolPipeline } from '@bah/runtime'
import { assertSafePathSegment } from '@bah/util'
import { describeThrown } from '@bah/core'

import { loadBundles } from '../bundles.ts'
import { readDefaultProfile, readLayers, readProfile } from '../profile.ts'
import { PLAN_ARMED_SERVICE, PLAN_WAKE_SERVICE } from '@bah/host'

import type { CliIo, CliOptions } from './run.ts'

/** `bah plan` 的用法说明。 */
export const PLAN_USAGE = [
  '用法：bah plan <list|wake|arm|disarm> [选项]',
  '',
  '  list                           列出授权窗口（含已撤销）',
  '  wake  [--at <ISO>] [--plan <id>] [--dry-run]',
  '                                 扫到期计划并执行；--at 只改判定时刻',
  '  arm   --file <plan.json>       从 JSON 签发授权窗口（走工具管线，需审批）',
  '  disarm --window <windowId>     撤销授权窗口（走工具管线，需审批）',
  '',
  '通用选项：--profile <name> --session <id> --jsonl <dir> --tenant <id> --home <dir>',
].join('\n')

/** 解析后的计划子命令。 */
export type PlanCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'wake'; readonly at?: string; readonly planId?: string; readonly dryRun: boolean }
  | { readonly kind: 'arm'; readonly file: string }
  | { readonly kind: 'disarm'; readonly windowId: string }

/** 通用参数（与 `bah` 主命令同名同义）。 */
export interface PlanCommonArgs {
  readonly profile?: string
  readonly session?: string
  readonly jsonl?: string
  readonly tenant?: string
  readonly home?: string
}

/** 解析结果。 */
export type PlanParse =
  | { readonly ok: true; readonly command: PlanCommand; readonly common: PlanCommonArgs; readonly help: boolean }
  | { readonly ok: false; readonly error: string }

/** 解析 `bah plan` 的参数（未知参数即用法错误）。 */
export function parsePlanArgs(argv: readonly string[]): PlanParse {
  const [sub, ...rest] = argv
  const common: {
    profile?: string
    session?: string
    jsonl?: string
    tenant?: string
    home?: string
  } = {}
  let at: string | undefined
  let planId: string | undefined
  let file: string | undefined
  let windowId: string | undefined
  let dryRun = false
  let help = false

  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index] as string
    const separator = raw.indexOf('=')
    const flag = separator > 0 ? raw.slice(0, separator) : raw
    const inline = separator > 0 ? raw.slice(separator + 1) : undefined
    const value = (): string | undefined => {
      const candidate = inline ?? rest[index + 1]
      if (candidate === undefined || candidate.length === 0) return undefined
      if (inline === undefined) index += 1
      return candidate
    }
    switch (flag) {
      case '--profile':
        common.profile = value()
        if (common.profile === undefined) return { ok: false, error: '--profile 需要一个值' }
        break
      case '--session':
        common.session = value()
        if (common.session === undefined) return { ok: false, error: '--session 需要一个值' }
        break
      case '--jsonl':
        common.jsonl = value()
        if (common.jsonl === undefined) return { ok: false, error: '--jsonl 需要一个值' }
        break
      case '--tenant':
        common.tenant = value()
        if (common.tenant === undefined) return { ok: false, error: '--tenant 需要一个值' }
        break
      case '--home':
        common.home = value()
        if (common.home === undefined) return { ok: false, error: '--home 需要一个值' }
        break
      case '--at':
        at = value()
        if (at === undefined) return { ok: false, error: '--at 需要一个值' }
        break
      case '--plan':
        planId = value()
        if (planId === undefined) return { ok: false, error: '--plan 需要一个值' }
        break
      case '--file':
        file = value()
        if (file === undefined) return { ok: false, error: '--file 需要一个值' }
        break
      case '--window':
        windowId = value()
        if (windowId === undefined) return { ok: false, error: '--window 需要一个值' }
        break
      case '--dry-run':
        if (inline !== undefined) return { ok: false, error: '--dry-run 不接受值' }
        dryRun = true
        break
      case '-h':
      case '--help':
        help = true
        break
      default:
        return { ok: false, error: `未知参数 ${raw}` }
    }
  }

  if (help) return { ok: true, command: { kind: 'list' }, common, help: true }

  switch (sub) {
    case 'list':
      return { ok: true, command: { kind: 'list' }, common, help: false }
    case 'wake':
      return {
        ok: true,
        command: {
          kind: 'wake',
          ...(at === undefined ? {} : { at }),
          ...(planId === undefined ? {} : { planId }),
          dryRun,
        },
        common,
        help: false,
      }
    case 'arm':
      if (file === undefined) return { ok: false, error: 'arm 需要 --file <plan.json>' }
      return { ok: true, command: { kind: 'arm', file }, common, help: false }
    case 'disarm':
      if (windowId === undefined) return { ok: false, error: 'disarm 需要 --window <windowId>' }
      return { ok: true, command: { kind: 'disarm', windowId }, common, help: false }
    default:
      return { ok: false, error: `未知子命令 ${String(sub)}` }
  }
}

/**
 * 跑一次 `bah plan`。
 *
 * @returns 退出码（0 成功 / 1 运行期失败 / 2 用法错误）
 */
export async function runPlan(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const parsed = parsePlanArgs(argv)
  if (!parsed.ok) {
    io.err(`bah plan: ${parsed.error}`)
    io.err(PLAN_USAGE)
    return 2
  }
  if (parsed.help) {
    io.out(PLAN_USAGE)
    return 0
  }

  const root = options.root ?? process.cwd()
  const now = options.now ?? (() => Date.now())
  const env = options.env ?? process.env

  try {
    const app = await bootForPlan(parsed.common, root, now, env, io, options)
    try {
      switch (parsed.command.kind) {
        case 'list': {
          const view = app.ctx.get(PLAN_ARMED_SERVICE)
          io.out(JSON.stringify(view.list(), null, 2))
          return 0
        }
        case 'wake': {
          const runner = app.ctx.get(PLAN_WAKE_SERVICE)
          const report = await runner.wake({
            at: parsed.command.at === undefined ? now() : Date.parse(parsed.command.at),
            ...(parsed.command.planId === undefined ? {} : { planId: parsed.command.planId }),
            dryRun: parsed.command.dryRun,
            source: 'cli',
          })
          if (!Number.isFinite(report.at)) {
            io.err('bah plan wake: --at 不是合法时间')
            return 2
          }
          io.out(JSON.stringify(report, null, 2))
          return report.ok ? 0 : 1
        }
        case 'arm': {
          const raw = await readJsonFile(parsed.command.file)
          return await runTool(app, io, 'plan_arm', raw, now)
        }
        case 'disarm': {
          return await runTool(app, io, 'plan_disarm', { windowId: parsed.command.windowId }, now)
        }
        default:
          // 构造不可达：`parsePlanArgs` 只产出上面四个 kind，未知子命令在 `!parsed.ok` 分支就返回 2 了。留这道守卫是为了新增 kind 时不静默走空。
          /* v8 ignore next 2 */
          return 2
      }
    } finally {
      await app.dispose('cli-plan-exit')
    }
  } catch (error) {
    io.err(`bah plan: ${describeThrown(error)}`)
    return 1
  }
}

/** 启动宿主（与 `bah` 主命令同一套 profile / patch / 会话解析）。 */
async function bootForPlan(
  common: PlanCommonArgs,
  root: string,
  now: () => number,
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  options: CliOptions,
): Promise<Awaited<ReturnType<typeof boot>>> {
  const { resolveTenantId } = await import('./run.ts')

  const name = common.profile ?? readDefaultProfile(root)
  if (name === undefined) {
    throw new Error('未指定 --profile，且 bah.yml 里没有 profile.default')
  }
  const profile = readProfile(root, name)
  const bundles = await loadBundles(root, profile.bundles)
  const rawSessionId = common.session ?? `s-plan-${now().toString(36)}`
  assertSafePathSegment(rawSessionId, '--session')
  const tenantId = resolveTenantId(common.tenant, env)
  const { layers } = readLayers(root, profile, {
    home: common.home ?? env['BAH_HOME'] ?? join(homedir(), '.bah'),
    overlays: [],
  })
  /**
   * CLI 就是"人工渠道"（ADR-0010）：操作者在终端敲 `bah plan arm` 等于本人点了批准。
   *
   * 为什么必须显式装，而不是靠 profile 的默认值：profile 自本设计起是
   * `responder: none + windowResponder: true`（无差别放行已删），不装的话
   * `bah plan arm` 会直接 `approval-no-responder`——运维入口被自己的安全默认值锁死。
   *
   * 三条边界：
   * 1. `autoVerify: false`：**红级不代验**。终端做不了人脸/短信，审批服务会把
   *    "未验过挑战的批准"归一化为 `challenge-required`（拒绝）——宽档武装只能在
   *    Web / 移动端完成，CLI 绝不替用户盖章；
   * 2. `headless` 不认领窗口票据，所以 `bah plan wake` 仍然只能由窗口核验端口签；
   * 3. 这是 overlay 层（最后合并），不改 profile 文件，审计里看得到 `from: 'cli:plan'`。
   */
  const cliChannel = {
    layer: 'overlay' as const,
    from: 'cli:plan',
    rows: [
      {
        id: 'interaction:approval',
        config: {
          responder: 'headless',
          autoDecision: 'allow',
          autoVerify: false,
          windowResponder: true,
        },
      },
    ],
  }
  void io
  return boot({
    profile,
    bundles,
    layers: [...layers, cliChannel],
    catalog: createCatalog(),
    run: {
      sessionId: rawSessionId as never,
      tenantId,
      now,
      probe: false,
      // 计划命令的语义就是"接着这个会话继续"：恢复历史（armed store 才能 replay 出窗口）
      restoreSession: true,
      ...(common.jsonl === undefined ? {} : { jsonlDir: common.jsonl }),
    },
    // 只有 boot 期告警（例如知识令牌回退）才会调用这条出口；CLI 用例都跑无告警的最小装配。属已知测试缺口，不是不可达代码。
    /* v8 ignore next */
    warn: (message) => io.err(`bah plan: ${message}`),
  })
}

/** 通过工具管线执行一个工具（arm / disarm），并把结构化结果打到 stdout。 */
async function runTool(
  app: Awaited<ReturnType<typeof boot>>,
  io: CliIo,
  name: string,
  args: unknown,
  now: () => number,
): Promise<number> {
  const session = app.ctx.get(SESSION_SERVICE)
  const pipeline = new ToolPipeline({
    ctx: app.ctx,
    registry: app.ctx.get(TOOLS_SERVICE),
    session,
    guard: new ToolGuard(),
    sessionId: session.sessionId,
    now,
  })
  const callArgs =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Readonly<Record<string, unknown>>)
      : {}
  const execution = await pipeline.execute({ callId: `cli-${String(now())}`, name, args: callArgs })
  for (const block of execution.result.content) {
    if (block.type === 'text') io.out(block.text)
  }
  if (execution.result.isError) {
    io.err(`bah plan: ${name} 失败（${execution.result.code ?? 'tool-failed'}）`)
    return 1
  }
  return 0
}

/** 读 JSON 文件（arm 的计划定义）。 */
async function readJsonFile(path: string): Promise<unknown> {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(path, 'utf8')
  return JSON.parse(text) as unknown
}
