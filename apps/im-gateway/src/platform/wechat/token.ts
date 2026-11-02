/**
 * access_token 缓存 / 单飞 / 失效重试。
 *
 * WHY 单飞：并发 20 条客服消息各自换一次 token，会立刻撞上微信的调用频控
 * （每天 2000 次），表现为"整点集体推送失败"。同一时刻只允许一个刷新 in-flight，
 * 其余等待同一个 Promise。
 *
 * 缓存口径：`expires_in - 300` 秒（留 5 分钟余量给网络与时钟漂移）。
 * 若微信给的 `expires_in ≤ 300`，至少缓存 60 秒——否则每条消息都刷新，违背缓存的意义。
 */

import { BahError } from '@bah/util'

/** 一次 HTTP 调用的结果（只保留网关需要的两项）。 */
export interface FetchJsonResult {
  readonly status: number
  readonly body: unknown
}

/** HTTP 调用（GET / POST；只发 JSON）。 */
export type FetchJson = (
  url: string,
  init?: { readonly method?: 'GET' | 'POST'; readonly body?: unknown },
) => Promise<FetchJsonResult>

/** token 缓存视图（测试与 `/healthz` 排障用，**不含 token 原文**）。 */
export interface TokenSnapshot {
  readonly expiresAtMs: number
  readonly refreshing: boolean
}

/** token 提供者。 */
export interface TokenProvider {
  /** 取一个可用 token（过期则刷新；并发调用共享同一次刷新）。 */
  get(): Promise<string>
  /** 让缓存失效（微信回 40001/42001 时调用；下一次 `get` 会重新换）。 */
  invalidate(): void
  /** 只读快照（不含 token 原文）。 */
  snapshot(): TokenSnapshot
}

/** 提前多久刷新（秒）。 */
const REFRESH_AHEAD_MS = 300_000
/** 最短缓存（毫秒）：微信给 `expires_in ≤ 300` 时不至于每条都刷新。 */
const MIN_TTL_MS = 60_000

/** token 依赖。 */
export interface TokenDeps {
  readonly appId: string
  readonly appSecret: string
  readonly apiBase: string
  readonly fetchJson: FetchJson
  /** 注入钟（毫秒）。 */
  readonly nowMs: () => number
}

/** token 接口失败（网络/JSON 结构/微信 errcode 都收敛成同一码，原文只进 reason 之外的日志）。 */
function tokenError(reason: string): BahError {
  return new BahError('im-wechat-token', `im: 换取 access_token 失败（${reason}）`)
}

/**
 * 造一个 token 提供者。
 *
 * @param deps 见 {@link TokenDeps}
 */
export function createTokenProvider(deps: TokenDeps): TokenProvider {
  let cached: { value: string; expiresAtMs: number } | undefined
  let inflight: Promise<string> | undefined

  const refresh = async (): Promise<string> => {
    const url =
      `${deps.apiBase}/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(deps.appId)}&secret=${encodeURIComponent(deps.appSecret)}`
    const response = await deps.fetchJson(url)
    if (response.status !== 200) throw tokenError(`http-${String(response.status)}`)

    const body = response.body
    if (typeof body !== 'object' || body === null) throw tokenError('non-object-body')
    const record = body as Record<string, unknown>
    const accessToken = record['access_token']
    const expiresIn = record['expires_in']
    if (typeof accessToken !== 'string' || accessToken.length === 0) throw tokenError('missing-access-token')
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw tokenError('missing-expires-in')
    }

    const ttl = Math.max(expiresIn * 1000 - REFRESH_AHEAD_MS, MIN_TTL_MS)
    cached = { value: accessToken, expiresAtMs: deps.nowMs() + ttl }
    return accessToken
  }

  return {
    async get(): Promise<string> {
      if (cached !== undefined && deps.nowMs() < cached.expiresAtMs) return cached.value
      if (inflight !== undefined) return inflight
      inflight = refresh().finally(() => {
        inflight = undefined
      })
      return inflight
    },

    invalidate(): void {
      cached = undefined
    },

    snapshot(): TokenSnapshot {
      return {
        expiresAtMs: cached?.expiresAtMs ?? 0,
        refreshing: inflight !== undefined,
      }
    },
  }
}
