/**
 * CLI 命令行（施工单 06 §5 第 1/4/6 步的入口面）。
 *
 * 三条纪律：
 * 1. **进程入口最小化**：`main.ts` 只解析 `argv` 并设置退出码，其它全在本文件（可单测）；
 * 2. **代码里没有渠道分支**：`--profile` 只是选一个数据目录，不做 `if (profile === 'web')`；
 * 3. 退出码有语义：`0` 成功、`1` 运行期失败（配置非法 / turn 失败）、`2` 用法错误。
 *
 * 参数解析返回**结果联合**而不是抛异常：这样"未知参数"这条分支在类型上就是可见的，
 * 也不会出现"catch 里再 throw"的不可测分支。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { describeThrown } from '@bah/core'
import { bootError, createCatalog, boot, SESSION_FILES, startConfigHmr } from '@bah/host'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import { BahError, assertNever } from '@bah/util'

import type { ConfigHmr } from '@bah/host'
import type { Agent, AgentRegistry, AnySessionEvent, TurnEndReason } from '@bah/runtime'
import type { Context, SessionId } from '@bah/core'

import { loadBundles } from '../bundles.ts'
import { renderDumpConfig } from '../dump-config.ts'
import { readDefaultProfile, readLayers, readProfile, type LayerOptions } from '../profile.ts'

/** 输出出口（测试注入收集器；生产是 console）。 */
export interface CliIo {
  out(message: string): void
  err(message: string): void
}

/** 可注入的运行环境（测试用临时仓库 / 固定时钟 / 假 HOME）。 */
export interface CliOptions {
  /** 仓库根（缺省 `process.cwd()`）。 */
  readonly root?: string
  /** 时钟（缺省 `Date.now`）。 */
  readonly now?: () => number
  /** 环境变量（读 `BAH_HOME`；缺省 `process.env`）。 */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** 一行用法（错误时附在提示后）。 */
export const USAGE = '用法：bah --profile <name> [--dump-config] [--prompt <text>] [选项]（-h 看完整帮助）'

/** 完整帮助。 */
export const HELP = [
  'bah —— BAH 底座 CLI（施工单 06）',
  '',
  USAGE,
  '',
  '选项：',
  '  --profile <name>   要启动的 profile（缺省取 bah.yml 的 profile.default）',
  '  --dump-config      打印生效的插件树（含每行来源层）后退出',
  '  --prompt <text>    跑一个 turn（headless 验收用）',
  '  --patch <file>     叠加一层 patch（可重复；层序最外）',
  '  --home <dir>       home patch 目录（缺省 $BAH_HOME 或 ~/.bah）',
  '  --jsonl <dir>      会话目录（覆盖 core:persistence.root）',
  '  --session <id>     会话 ID（缺省按时钟生成）',
  '  -h, --help         显示本帮助',
].join('\n')

/** 解析后的命令行。 */
interface Args {
  readonly profile?: string
  readonly dumpConfig: boolean
  readonly prompt?: string
  readonly patch: readonly string[]
  readonly home?: string
  readonly jsonl?: string
  readonly session?: string
  readonly help: boolean
}

/** 参数解析结果：成功带 args，失败带一行可读理由（退出码 2）。 */
export type ParseResult =
  | { readonly ok: true; readonly args: Args }
  | { readonly ok: false; readonly error: string }

/**
 * 跑一次 CLI。
 *
 * @returns 退出码（0 成功 / 1 运行期失败 / 2 用法错误）
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    io.err(`bah: ${parsed.error}`)
    io.err(USAGE)
    return 2
  }

  if (parsed.args.help) {
    io.out(HELP)
    return 0
  }

  const root = options.root ?? process.cwd()
  const now = options.now ?? (() => Date.now())
  const env = options.env ?? process.env

  try {
    return await runProfile(parsed.args, io, root, now, env)
  } catch (error) {
    io.err(`bah: ${describeThrown(error)}`)
    return 1
  }
}

/** 启动 profile（`--dump-config` 或跑一个 turn）。 */
async function runProfile(
  args: Args,
  io: CliIo,
  root: string,
  now: () => number,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const name = args.profile ?? readDefaultProfile(root)
  if (name === undefined) {
    throw bootError('profile-unspecified', '未指定 --profile，且 bah.yml 里没有 profile.default')
  }

  const profile = readProfile(root, name)
  const bundles = await loadBundles(root, profile.bundles)
  const layerOptions: LayerOptions = {
    home: args.home ?? defaultHome(env),
    overlays: args.patch,
  }
  const { layers, files } = readLayers(root, profile, layerOptions)
  const sessionId = (args.session ?? `s-${now().toString(36)}`) as SessionId

  const app = await boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: { sessionId, now, ...(args.jsonl === undefined ? {} : { jsonlDir: args.jsonl }) },
    warn: (message) => io.err(`bah: ${message}`),
  })

  let hmr: ConfigHmr | undefined
  try {
    if (args.dumpConfig) {
      io.out(renderDumpConfig(app.profile, app.rows()))
      return 0
    }

    hmr = startConfigHmr({
      profile,
      files,
      reload: () => app.reload(readLayers(root, profile, layerOptions).layers),
      warn: (message) => io.err(`bah: ${message}`),
    })
    if (hmr !== undefined) {
      io.out(`bah: config HMR 开，监听 ${hmr.files.length} 个 patch 文件（插件行增删需重启）`)
    }

    if (args.prompt === undefined) {
      throw bootError('prompt-missing', '需要 --prompt <text> 才能跑 turn（或加 --dump-config 只看配置）')
    }

    const agent = onlyAgent(app.ctx)
    io.out(`bah: profile ${profile.name} · 会话 ${String(sessionId)}`)
    agent.send(args.prompt)
    await agent.run()

    const session = app.ctx.get(SESSION_SERVICE)
    const events = session.events()
    io.out(`bah: 回复 ${lastAssistantText(events)}`)
    printKnowledgeCard(events, io)
    io.out(`bah: 已落盘 ${app.ctx.get(SESSION_FILES).fileOf(sessionId)}（${session.lastSeq()} 条事件）`)

    const end = lastTurnEnd(events)
    if (end !== undefined && end.kind !== 'completed') {
      io.err(`bah: turn 未正常完成：${describeReason(end)}`)
      return 1
    }
    return 0
  } finally {
    hmr?.stop()
    await app.dispose('cli-exit')
  }
}

/**
 * 解析参数（支持 `--flag value` 与 `--flag=value`）。
 *
 * 未知参数、缺值、给布尔开关赋值都算用法错误（退出码 2）。
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  let profile: string | undefined
  let dumpConfig = false
  let prompt: string | undefined
  let home: string | undefined
  let jsonl: string | undefined
  let session: string | undefined
  let help = false
  const patch: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!
    const separator = raw.indexOf('=')
    const flag = separator > 0 ? raw.slice(0, separator) : raw
    const inline = separator > 0 ? raw.slice(separator + 1) : undefined

    /** 取本开关的值（`--flag=value` 或下一个 argv 项）。 */
    const value = (): string | undefined => {
      const candidate = inline ?? argv[index + 1]
      if (candidate === undefined || candidate.length === 0) return undefined
      if (inline === undefined) index += 1
      return candidate
    }

    switch (flag) {
      case '--profile': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        profile = read
        break
      }
      case '--prompt': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        prompt = read
        break
      }
      case '--patch': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        patch.push(read)
        break
      }
      case '--home': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        home = read
        break
      }
      case '--jsonl': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        jsonl = read
        break
      }
      case '--session': {
        const read = value()
        if (read === undefined) return failure(`${flag} 需要一个值`)
        session = read
        break
      }
      case '--dump-config':
        if (inline !== undefined) return failure(`${flag} 不接受值（写成 ${flag}）`)
        dumpConfig = true
        break
      case '-h':
      case '--help':
        if (inline !== undefined) return failure(`${flag} 不接受值（写成 ${flag}）`)
        help = true
        break
      default:
        return failure(`未知参数 ${raw}`)
    }
  }

  return {
    ok: true,
    args: {
      dumpConfig,
      help,
      patch,
      ...(profile === undefined ? {} : { profile }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(home === undefined ? {} : { home }),
      ...(jsonl === undefined ? {} : { jsonl }),
      ...(session === undefined ? {} : { session }),
    },
  }
}

/** 造一个用法失败结果。 */
function failure(error: string): ParseResult {
  return { ok: false, error }
}

/** home patch 目录：`--home` > `$BAH_HOME` > `~/.bah`。 */
function defaultHome(env: Readonly<Record<string, string | undefined>>): string {
  return env['BAH_HOME'] ?? join(homedir(), '.bah')
}

/**
 * 取唯一活体 agent。
 *
 * 一个 profile 只有一个 `core:agent` 行；想挂第二个会被依赖清单的 `duplicate-plugin` 挡住
 * （施工单 06 的"同一插件只能挂一次"），所以这里不处理"多于一个"。
 *
 * @throws `BahError('agent-absent')` agent 服务未注册 / 注册表为空（profile 少装了 `core:agent`）
 */
export function onlyAgent(ctx: Context): Agent {
  let registry: AgentRegistry
  try {
    registry = ctx.get(AGENTS_SERVICE)
  } catch (error) {
    // `Context.get` 对未注册服务 fail-loud；这里把它翻译成"这个 profile 没有 agent"这一事实
    if (error instanceof BahError && error.code === 'service-missing') {
      throw bootError('agent-absent', '没有活体 agent：profile 里缺少 core:agent 行')
    }
    throw error
  }

  const first = registry.list()[0]
  if (first === undefined) {
    throw bootError('agent-absent', '没有活体 agent：core:agent 已装但注册表为空')
  }
  return first
}

/** 最后一条有文本的 assistant 回复（多段文本按序拼接）。 */
export function lastAssistantText(events: readonly AnySessionEvent[]): string {
  let text = ''
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const joined = event.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (joined.length > 0) text = joined
  }
  return text.length > 0 ? text : '（本轮没有文本回复）'
}

/**
 * 最后一张知识卡（`knowledge_answer` 的工具结果投影）。
 *
 * 只读 `tool/result`：那是已校验答案的唯一权威落点；assistant 正文只是引导语。
 * 缺省返回 `undefined`——没有知识工具调用时 CLI 不额外打印任何东西。
 */
export function lastKnowledgeAnswer(events: readonly AnySessionEvent[]): string | undefined {
  let text: string | undefined
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const data = event.data
    if (data.name !== 'knowledge_answer' || data.isError) continue
    const joined = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (joined.length > 0) text = joined
  }
  return text
}

/** 有知识卡就打印；没有则静默（普通 turn 不额外输出）。 */
export function printKnowledgeCard(events: readonly AnySessionEvent[], io: CliIo): void {
  const knowledge = lastKnowledgeAnswer(events)
  if (knowledge !== undefined) io.out(`bah: 知识卡\n${knowledge}`)
}

/** 最后一次 turn 的结束原因。 */
export function lastTurnEnd(events: readonly AnySessionEvent[]): TurnEndReason | undefined {
  let last: TurnEndReason | undefined
  for (const event of events) {
    if (event.type === 'turn/end') last = event.data.reason
  }
  return last
}

/** 结束原因的可读文案（封闭联合以 `assertNever` 收尾）。 */
export function describeReason(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked（入口拒绝）'
    case 'aborted':
      return 'aborted（已中断）'
    case 'max-tokens':
      return 'max-tokens（输出上限）'
    case 'guard-stopped':
      return `guard-stopped（判停：${reason.reason}）`
    case 'failed':
      return `failed（${reason.reason}）`
    default:
      return assertNever(reason, 'turn-end-reason')
  }
}
