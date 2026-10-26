/**
 * `bah halt` / `bah unfreeze`（W07 / HP-3 的人工控制面）。
 *
 * ## 为什么是 HTTP 客户端而不是"boot 一个新 app"
 *
 * HALT 是**进程级**状态，票据也在运行中宿主的 `TicketLedger` 里。新进程里的状态机
 * 与运行中的那个毫无关系——boot 一个新 app 再调用只会得到"看起来解冻了"的假象
 * （HP-0 §0.2 的同一课）。所以两个命令都只打运行中 web 宿主的本机管理路由。
 *
 * ## 三条纪律
 *
 * 1. token 只从环境变量 `BAH_ADMIN_TOKEN` 读，**不接受 `--token`**（会进 shell history 与进程列表）；
 * 2. **没有 `--force`**：解除只能凭会话内 U 盾 MFA 审批签发的票据；
 * 3. 任何输出都不打印 token，也不打印请求 init（可能带 authorization 头）。
 */

import { ADMIN_TOKEN_ENV } from '@bah/host'

/** 用法（错误时附在提示后）。 */
export const HALT_USAGE = '用法：bah halt [--url http://127.0.0.1:7331] [--detail <text>]'

/** `bah unfreeze` 的用法。 */
export const UNFREEZE_USAGE =
  '用法：bah unfreeze (--ticket <id> | --request) [--url http://127.0.0.1:7331]'

/** 完整帮助。 */
export const HALT_HELP = [
  'bah halt / bah unfreeze —— HALT 人工控制面（W07）',
  '',
  HALT_USAGE,
  UNFREEZE_USAGE,
  '',
  '子命令：',
  '  halt               人工进入 HALT（reason 固定 manual）',
  '  unfreeze           解除 HALT（只有一条路径：凭会话内 MFA 票据）',
  '',
  '选项：',
  '  --url <url>        运行中 web 宿主的地址（缺省 http://127.0.0.1:7331）',
  '  --detail <text>    HALT 详情（可选，≤200 字符；会进审计）',
  '  --ticket <id>      解除票据 ID（会话内 U 盾审批签发）',
  '  --request          在运行中的会话里申请一张解除票据（需要有人完成 U 盾验证）',
  '',
  `token 只从环境变量 ${ADMIN_TOKEN_ENV} 读，不接受命令行参数`,
  '',
  '注意：没有 --force，也不提供"跳过票据"的开关——解除是人工动作，不是运维后门。',
  'headless / plan profile 没有 HTTP 服务，无法远程解除；只能重启进程。',
].join('\n')

/** 输出出口（与 `CliIo` 同形，避免循环依赖）。 */
export interface HaltIo {
  out(message: string): void
  err(message: string): void
}

/** 最小 `fetch` 形状（测试注入，不真连网络）。 */
export type HaltFetch = (input: string, init?: RequestInit) => Promise<Response>

/** 可注入环境。 */
export interface HaltRunOptions {
  readonly fetchImpl?: HaltFetch
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** 缺省 URL（与 `DEFAULT_WEB.port` 对齐）。 */
const DEFAULT_URL = 'http://127.0.0.1:7331'

/** 票据 ID 的保守字符集（与服务端 `parseUnfreezeTicketBody` 同口径）。 */
const TICKET_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/

/** 一行的解析结果。 */
type ParsedHalt =
  | { readonly ok: true; readonly url: string; readonly detail?: string }
  | { readonly ok: false; readonly error: string }

type ParsedUnfreeze =
  | { readonly ok: true; readonly url: string; readonly mode: 'ticket'; readonly ticketId: string }
  | { readonly ok: true; readonly url: string; readonly mode: 'request' }
  | { readonly ok: false; readonly error: string }

/** 读 `--url` 的值并归一化（去尾斜杠）。 */
function readUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.replace(/\/+$/, '')
}

/** 解析 `bah halt` 的参数。 */
function parseHaltArgs(argv: readonly string[]): ParsedHalt {
  let url = DEFAULT_URL
  let detail: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--url': {
        const next = readUrl(value)
        if (next === undefined) return { ok: false, error: '--url 需要值' }
        if (!/^https?:\/\//i.test(next)) return { ok: false, error: '--url 只支持 http/https' }
        url = next
        index += 1
        break
      }
      case '--detail': {
        if (value === undefined) return { ok: false, error: '--detail 需要值' }
        const trimmed = value.trim()
        if (trimmed !== '' && [...trimmed].length > 200) {
          return { ok: false, error: '--detail 不得超过 200 字符' }
        }
        if (trimmed !== '') detail = trimmed
        index += 1
        break
      }
      default:
        return { ok: false, error: `未知参数：${flag ?? ''}` }
    }
  }

  return detail === undefined ? { ok: true, url } : { ok: true, url, detail }
}

/** 解析 `bah unfreeze` 的参数（`--ticket` 与 `--request` 互斥且必填其一）。 */
function parseUnfreezeArgs(argv: readonly string[]): ParsedUnfreeze {
  let url = DEFAULT_URL
  let ticketId: string | undefined
  let request = false

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--url': {
        const next = readUrl(value)
        if (next === undefined) return { ok: false, error: '--url 需要值' }
        if (!/^https?:\/\//i.test(next)) return { ok: false, error: '--url 只支持 http/https' }
        url = next
        index += 1
        break
      }
      case '--ticket': {
        if (value === undefined) return { ok: false, error: '--ticket 需要值' }
        const trimmed = value.trim()
        if (!TICKET_ID_PATTERN.test(trimmed)) {
          return { ok: false, error: '--ticket 非法（128 字符以内的字母数字与 :_.-）' }
        }
        ticketId = trimmed
        index += 1
        break
      }
      case '--request':
        request = true
        break
      default:
        return { ok: false, error: `未知参数：${flag ?? ''}` }
    }
  }

  if (ticketId !== undefined && request) {
    return { ok: false, error: '--ticket 与 --request 只能二选一' }
  }
  if (ticketId === undefined && !request) {
    return { ok: false, error: '必须提供 --ticket <id> 或 --request（没有无票据解除）' }
  }
  return ticketId === undefined
    ? { ok: true, url, mode: 'request' }
    : { ok: true, url, mode: 'ticket', ticketId }
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

/** 发一次管理面 POST。 */
async function postAdmin(
  url: string,
  path: string,
  token: string,
  body: unknown,
  fetchImpl: HaltFetch,
): Promise<Response | { readonly error: string }> {
  try {
    return await fetchImpl(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch (error) {
    // 不打印 error 对象本身：它可能带着请求 init（含 authorization 头）
    const detail = error instanceof Error ? error.message : String(error)
    return { error: `无法连接 web 宿主（${url}）：${detail}` }
  }
}

/** 管理面鉴权 / 路由存在性失败的统一提示。 */
function explainAdminFailure(response: Response, action: string): string {
  if (response.status === 404) {
    return '管理路由未启用：请确认 profile 是 web 且宿主已设置 ' + ADMIN_TOKEN_ENV
  }
  if (response.status === 401 || response.status === 403) {
    return `拒绝访问（${String(response.status)}）：token 或来源不合法`
  }
  return `${action}失败（${String(response.status)}）`
}

/** 读 JSON 体（失败返回 undefined）。 */
async function readJsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 跑 `bah halt`。
 *
 * @returns 退出码：0 成功（含幂等 no-op）、1 运行期失败、2 用法 / 环境错误
 */
export async function runHalt(
  argv: readonly string[],
  io: HaltIo,
  options: HaltRunOptions = {},
): Promise<number> {
  const parsed = parseHaltArgs(argv)
  if (!parsed.ok) {
    io.err(`bah halt: ${parsed.error}`)
    io.err(HALT_USAGE)
    return 2
  }

  const env = options.env ?? process.env
  const token = env[ADMIN_TOKEN_ENV]?.trim()
  if (token === undefined || token === '') {
    io.err(`bah halt: 缺少环境变量 ${ADMIN_TOKEN_ENV}（token 只从环境变量读）`)
    return 2
  }

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const response = await postAdmin(
    parsed.url,
    '/api/admin/halt',
    token,
    parsed.detail === undefined ? {} : { detail: parsed.detail },
    fetchImpl,
  )
  if ('error' in response) {
    io.err(response.error)
    return 1
  }
  if (!response.ok) {
    io.err(`${explainAdminFailure(response, 'HALT')} ${await httpBodyCode(response)}`)
    return 1
  }

  const body = await readJsonBody(response)
  if (body === undefined) {
    io.err('HALT 失败：宿主返回的不是 JSON')
    return 1
  }
  if (body['changed'] === true) {
    io.out(parsed.detail === undefined ? '已进入 HALT' : `已进入 HALT（detail=${parsed.detail}）`)
  } else {
    io.out('已处于 HALT（幂等 no-op）')
  }
  return 0
}

/**
 * 跑 `bah unfreeze`。
 *
 * @returns 退出码：0 成功（含幂等 no-op）、1 运行期失败、2 用法 / 环境错误
 */
export async function runUnfreeze(
  argv: readonly string[],
  io: HaltIo,
  options: HaltRunOptions = {},
): Promise<number> {
  const parsed = parseUnfreezeArgs(argv)
  if (!parsed.ok) {
    io.err(`bah unfreeze: ${parsed.error}`)
    io.err(UNFREEZE_USAGE)
    return 2
  }

  const env = options.env ?? process.env
  const token = env[ADMIN_TOKEN_ENV]?.trim()
  if (token === undefined || token === '') {
    io.err(`bah unfreeze: 缺少环境变量 ${ADMIN_TOKEN_ENV}（token 只从环境变量读）`)
    return 2
  }

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))

  if (parsed.mode === 'request') {
    const response = await postAdmin(
      parsed.url,
      '/api/admin/halt/unfreeze-request',
      token,
      {},
      fetchImpl,
    )
    if ('error' in response) {
      io.err(response.error)
      return 1
    }
    if (!response.ok) {
      io.err(`${explainAdminFailure(response, '申请解除')} ${await httpBodyCode(response)}`)
      return 1
    }
    const body = await readJsonBody(response)
    if (body === undefined || typeof body['ticketId'] !== 'string') {
      io.err('申请解除失败：宿主没有返回票据 ID')
      return 1
    }
    io.out(`解除票据已签发：${body['ticketId']}`)
    io.out(`下一步：bah unfreeze --ticket ${body['ticketId']}`)
    return 0
  }

  const response = await postAdmin(
    parsed.url,
    '/api/admin/halt/unfreeze',
    token,
    { ticketId: parsed.ticketId },
    fetchImpl,
  )
  if ('error' in response) {
    io.err(response.error)
    return 1
  }
  if (response.status === 409) {
    // 本来就没 HALT：幂等 no-op，不是错误
    io.out('当前没有处于 HALT')
    return 0
  }
  if (!response.ok) {
    io.err(`${explainAdminFailure(response, '解除 HALT')} ${await httpBodyCode(response)}`)
    return 1
  }
  io.out('已解除 HALT，系统恢复 RUNNING')
  return 0
}
