/**
 * 观测类 CLI 的公共 HTTP 小件（`bah metrics` / `bah trace` 共用）。
 *
 * 三条纪律：
 * 1. **token 不落日志**：只回显「已从 BAH_WEB_TOKEN 读取」，任何错误串都不带它；
 * 2. **退出码可判**：用法错误由各命令自己给 2，这里只把网络/HTTP 失败归一成结果；
 * 3. **只读**：GET 一个文本体，不解析业务（解析由命令决定）。
 */

/** 缺省宿主地址（与 `DEFAULT_WEB.port` 对齐）。 */
export const OBS_DEFAULT_URL = 'http://127.0.0.1:7331'

/** 最小 `fetch` 形状（测试注入）。 */
export type ObserveFetch = (input: string, init?: RequestInit) => Promise<Response>

/** 一次 GET 的结果（`ok:false` 时 `code` 是结构化理由码）。 */
export type HttpOutcome =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | { readonly ok: false; readonly status: number; readonly code: string }

/**
 * token 优先级：`--token` > `$BAH_WEB_TOKEN`；都没有返回 `undefined`。
 *
 * 命令行参数会进 shell history，但这里**只在帮助里提示**，不主动打印值。
 */
export function tokenOf(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = flag ?? env['BAH_WEB_TOKEN']
  const trimmed = raw?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** 从错误体里取 `error.code`（取不到用状态码兜底）。 */
function codeOf(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } }
    const code = body.error?.code
    return typeof code === 'string' && code.length > 0 ? code : `http-${String(status)}`
  } catch {
    return `http-${String(status)}`
  }
}

/** GET 一个 URL，返回文本或结构化失败。 */
export async function getText(
  fetchImpl: ObserveFetch,
  url: string,
  token: string,
): Promise<HttpOutcome> {
  let response: Response
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, code: `network-error: ${detail}` }
  }

  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }

  if (!response.ok) return { ok: false, status: response.status, code: codeOf(text, response.status) }
  return { ok: true, status: response.status, text }
}

/** 校验 `--url` 只接受 http/https，并去掉尾部斜杠。 */
export function normalizeUrl(raw: string): string | undefined {
  if (!/^https?:\/\//i.test(raw)) return undefined
  return raw.replace(/\/+$/, '')
}

/** 正整数解析（`--limit` / `--watch` 共用）。 */
export function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}
