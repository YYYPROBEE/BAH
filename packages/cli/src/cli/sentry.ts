/**
 * `bah sentry unfreeze`（施工单 HP-0 §3.3）。
 *
 * ## 它是什么、不是什么
 *
 * 断路器是**进程内状态**（`SentryBreaker` 持有内核 `Breaker`）。所以这个命令
 * **不能** "boot 一个新 app 再调 unfreeze"——那只解了新进程里的假断路器，
 * 正在跑的 web 进程仍然冻结。它只是一个 HTTP 客户端，打运行中宿主的
 * `POST /api/admin/sentry/unfreeze`。
 *
 * ## 两条纪律
 *
 * 1. **token 只从环境变量读**，不提供 `--token`：命令行参数会进进程列表与 shell history；
 * 2. **不打印 token**，任何错误信息里都不带它。
 */

import { ADMIN_TOKEN_ENV, DEFAULT_UNFREEZE_REASON } from '@bah/host'

/** 用法一行。 */
export const SENTRY_USAGE =
  '用法：bah sentry unfreeze [--url http://127.0.0.1:7331] [--reason <text>]'

/** 完整帮助。 */
export const SENTRY_HELP = [
  'bah sentry —— sentry 断路器管理（施工单 HP-0）',
  '',
  SENTRY_USAGE,
  '',
  '子命令：',
  '  unfreeze           显式人工解冻（唯一解除路径；本就未冻结时是幂等 no-op）',
  '',
  '选项：',
  '  --url <url>        运行中 web 宿主的地址（缺省 http://127.0.0.1:7331）',
  '  --reason <text>    理由（可选，≤200 字符；缺省 operator-unfreeze）',
  '',
  `操作者由宿主的 ${ADMIN_TOKEN_ENV} / BAH_ADMIN_OPERATORS 派生（03 TA-44），`,
  '不再接受 --by：body 里自报操作者一律 400。',
  `token 只从环境变量 ${ADMIN_TOKEN_ENV} 读，不接受命令行参数`,
  '（宿主配了操作员表时，这里填该操作员的 token 即可）。',
  '',
  '注意：headless profile 没有 HTTP 服务，**无法远程解冻**——只能重启进程。',
].join('\n')

/** 输出出口（与 `CliIo` 同形，避免循环依赖）。 */
export interface SentryIo {
  out(message: string): void
  err(message: string): void
}

/** 最小 `fetch` 形状（测试注入，不真连网络）。 */
export type SentryFetch = (input: string, init?: RequestInit) => Promise<Response>

/** 可注入环境。 */
export interface SentryRunOptions {
  readonly fetchImpl?: SentryFetch
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** 缺省 URL（与 `DEFAULT_WEB.port` 对齐）。 */
const DEFAULT_URL = 'http://127.0.0.1:7331'

/** 一行的解析结果。 */
type Parsed =
  | { readonly ok: true; readonly url: string; readonly reason: string }
  | { readonly ok: false; readonly error: string }

/**
 * 解析 `unfreeze` 的参数。
 *
 * 返回结果联合而不是抛异常：用法错误必须有**稳定退出码 2**，
 * 不能与运行期失败（1）混在一起。
 */
function parseArgs(argv: readonly string[]): Parsed {
  let url = DEFAULT_URL
  let reason = DEFAULT_UNFREEZE_REASON

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--url':
        if (value === undefined) return { ok: false, error: '--url 需要值' }
        if (!/^https?:\/\//i.test(value)) return { ok: false, error: '--url 只支持 http/https' }
        url = value.replace(/\/+$/, '')
        index += 1
        break
      case '--by':
        // 03 TA-44：操作者由服务端 token 派生。显式报错而不是静默忽略——
        // "传了但没生效"会让运维以为链上记的是自己写的那个名字。
        return {
          ok: false,
          error: '--by 已移除：操作者由 admin token 派生（服务端记录 by）',
        }
      case '--reason':
        if (value === undefined) return { ok: false, error: '--reason 需要值' }
        reason = value.trim() === '' ? DEFAULT_UNFREEZE_REASON : value.trim()
        index += 1
        break
      default:
        return { ok: false, error: `未知参数：${flag ?? ''}` }
    }
  }

  if ([...reason].length > 200) return { ok: false, error: '--reason 不得超过 200 字符' }
  return { ok: true, url, reason }
}

/** 从响应体里取错误码（取不到就用状态码兜底）。 */
async function httpBodyCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string; reason?: string } }
    const code = body.error?.code
    return code === undefined ? `HTTP ${String(response.status)}` : code
  } catch {
    return `HTTP ${String(response.status)}`
  }
}

/**
 * 跑 `bah sentry unfreeze`。
 *
 * @returns 退出码：0 成功（含幂等 no-op）、1 运行期失败、2 用法错误
 */
export async function runSentryUnfreeze(
  argv: readonly string[],
  io: SentryIo,
  options: SentryRunOptions = {},
): Promise<number> {
  const sub = argv[0]
  if (sub !== 'unfreeze') {
    io.err(`bah sentry: ${sub === undefined ? '缺少子命令' : `未知子命令 ${sub}`}`)
    io.err(SENTRY_USAGE)
    return 2
  }

  const parsed = parseArgs(argv.slice(1))
  if (!parsed.ok) {
    io.err(`bah sentry unfreeze: ${parsed.error}`)
    io.err(SENTRY_USAGE)
    return 2
  }

  const env = options.env ?? process.env
  const token = env[ADMIN_TOKEN_ENV]?.trim()
  if (token === undefined || token === '') {
    io.err(`bah sentry unfreeze: 缺少环境变量 ${ADMIN_TOKEN_ENV}（token 只从环境变量读）`)
    return 2
  }

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))

  let response: Response
  try {
    response = await fetchImpl(`${parsed.url}/api/admin/sentry/unfreeze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: parsed.reason }),
    })
  } catch (error) {
    // 不打印 error 对象本身：它可能带着请求 init（含 authorization 头）
    const detail = error instanceof Error ? error.message : String(error)
    io.err(`无法连接 web 宿主（${parsed.url}）：${detail}`)
    return 1
  }

  if (response.status === 404) {
    // 404 有两种含义：路径不存在，或宿主没启管理路由（未设 token）
    io.err('管理路由未启用：请确认 profile 是 web 且宿主已设置 ' + ADMIN_TOKEN_ENV)
    return 1
  }
  if (response.status === 401 || response.status === 403) {
    io.err(`拒绝访问（${String(response.status)} ${await httpBodyCode(response)}）：token 或来源不合法`)
    return 1
  }
  if (!response.ok) {
    io.err(`解冻失败（${String(response.status)} ${await httpBodyCode(response)})`)
    return 1
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    io.err('解冻失败：宿主返回的不是 JSON')
    return 1
  }
  const payload = body as { unfrozen?: unknown; by?: unknown }
  const operator = typeof payload.by === 'string' && payload.by !== '' ? payload.by : undefined
  const suffix = operator === undefined ? '' : `（by=${operator}）`
  if (payload.unfrozen === true) {
    io.out(`已解冻${suffix}`)
    return 0
  }
  io.out(`当前未处于冻结状态${suffix}`)
  return 0
}
