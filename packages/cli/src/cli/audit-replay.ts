/**
 * `bah audit replay`（W15）：独立重放的一个 CLI 入口。
 *
 * 与 `scripts/replay.ts` 共享 `@bah/persistence` 的重放实现；本文件只做参数与输出，
 * 不启动 Agent / 不调模型 / 不调工具。
 */

import { resolve } from 'node:path'

import { replaySession } from '@bah/persistence'

import type { CliIo, CliOptions } from './run.ts'

/** 解析后的参数。 */
export interface AuditReplayArgs {
  readonly session?: string
  readonly dir: string
  readonly key?: string
  readonly format: 'text' | 'json'
  readonly help: boolean
}

/** 参数解析。 */
export function parseAuditReplayArgs(
  argv: readonly string[],
): { ok: true; args: AuditReplayArgs } | { ok: false; error: string } {
  let session: string | undefined
  let dir = 'sessions'
  let key: string | undefined
  let format: 'text' | 'json' = 'text'
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
      case '--session': {
        const read = value()
        if (read === undefined) return { ok: false, error: '--session 需要一个值' }
        session = read
        break
      }
      case '--dir': {
        const read = value()
        if (read === undefined) return { ok: false, error: '--dir 需要一个值' }
        dir = read
        break
      }
      case '--key': {
        const read = value()
        if (read === undefined) return { ok: false, error: '--key 需要一个值' }
        key = read
        break
      }
      case '--format': {
        const read = value()
        if (read === undefined) return { ok: false, error: '--format 需要一个值' }
        if (read !== 'text' && read !== 'json') return { ok: false, error: '--format 只接受 text | json' }
        format = read
        break
      }
      case '--verify':
        break
      case '-h':
      case '--help':
        help = true
        break
      default:
        return { ok: false, error: `未知参数 ${raw}` }
    }
  }
  return {
    ok: true,
    args: {
      ...(session === undefined ? {} : { session }),
      dir,
      ...(key === undefined ? {} : { key }),
      format,
      help,
    },
  }
}

/** 执行 `bah audit replay`。 */
export async function runAuditReplay(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const parsed = parseAuditReplayArgs(argv)
  if (!parsed.ok) {
    io.err(`bah audit replay: ${parsed.error}`)
    return 2
  }
  if (parsed.args.help || parsed.args.session === undefined) {
    io.out(
      [
        'bah audit replay —— 只读重放会话（不启动 Agent / 不调模型 / 不调工具）',
        '',
        '用法：bah audit replay --session <id> [--dir sessions] [--key <pem>] [--format text|json]',
      ].join('\n'),
    )
    return parsed.args.help ? 0 : 2
  }
  const cwd = options.root ?? process.cwd()
  const result = replaySession({
    root: resolve(cwd, parsed.args.dir),
    sessionId: parsed.args.session,
    ...(parsed.args.key === undefined ? {} : { keyPath: resolve(cwd, parsed.args.key) }),
  })
  if (parsed.args.format === 'json') {
    io.out(JSON.stringify(result, null, 2))
  } else {
    io.out(
      `${result.ok ? '✔' : '✘'} replay session=${result.sessionId} events=${String(result.events.length)} ` +
        `decisions=${String(result.decisions.length)} tickets=${String(result.tickets.length)} ` +
        `chain=${result.chain.ok ? 'ok' : `broken@${String(result.chain.brokenAt ?? 0)}`} ` +
        `seq=${result.seqOk ? 'ok' : 'gap'} diff=${String(result.diffs.length)} warn=${String(result.warnings.length)}`,
    )
    for (const diff of result.diffs) io.err(`  - ${diff}`)
  }
  return result.ok ? 0 : 1
}
