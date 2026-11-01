/**
 * 微信客服消息传输。
 *
 * 三条口径：
 * 1. **一律转拉取式**：任何失败都不向用户暴露 errcode，只记日志并把结果放进拉取缓存；
 * 2. **失效只重试一次**：`40001/42001` 说明 token 被别人顶掉/过期，刷新后重试一次；
 *    重试第二次仍失败就认输——不刷新重试会在频控边缘刷爆 API（§9.2 的反例）；
 * 3. **没有第三方 HTTP 客户端**：生产用 Node 内置 `fetch`，测试注入假实现。
 */

import type { PlatformPushResult } from '@bah/channels'

import type { ImLogger } from '../../log.ts'
import type { FetchJson, TokenProvider } from './token.ts'

/** 客服消息依赖。 */
export interface WechatTransportDeps {
  readonly token: TokenProvider
  readonly apiBase: string
  readonly fetchJson: FetchJson
  readonly log: ImLogger
}

/** 发送一条文本（返回值直接进 `PlatformPushResult`）。 */
export type PushText = (userId: string, text: string) => Promise<PlatformPushResult>

/** 微信 errcode → 网关语义（未登记的一律 `failed`）。 */
export function mapErrcode(errcode: number): 'expired-window' | 'unauthorized' | 'quota' | 'failed' {
  switch (errcode) {
    case 45015:
      return 'expired-window'
    case 48001:
      return 'unauthorized'
    case 45009:
      return 'quota'
    default:
      return 'failed'
  }
}

/** 从响应体里读 errcode（0 或缺失视为成功）。 */
function errcodeOf(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)['errcode']
  if (typeof value !== 'number') return undefined
  return value === 0 ? undefined : value
}

 /**
  * 造一个客服消息发送器。
  *
  * @param deps 见 {@link WechatTransportDeps}
  */
export function createWechatPushText(deps: WechatTransportDeps): PushText {
  return async (userId, text): Promise<PlatformPushResult> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let accessToken: string
      try {
        accessToken = await deps.token.get()
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'token-error'
        deps.log.warn('im-push-failed', { reason, code: 'token' })
        return { ok: false, code: 'failed', reason: 'token' }
      }

      const url = `${deps.apiBase}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(accessToken)}`
      let response
      try {
        response = await deps.fetchJson(url, {
          method: 'POST',
          body: { touser: userId, msgtype: 'text', text: { content: text } },
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'network-error'
        deps.log.warn('im-push-failed', { reason, code: 'network' })
        return { ok: false, code: 'failed', reason: 'network' }
      }

      const errcode = errcodeOf(response.body)
      if (errcode === undefined && response.status === 200) return { ok: true }

      if (errcode === 40001 || errcode === 42001) {
        // token 被顶掉：刷新后重试一次；第二次仍失效说明凭证配错，认输。
        deps.token.invalidate()
        if (attempt === 0) continue
        deps.log.warn('im-push-failed', { reason: 'token-invalid', errcode })
        return { ok: false, code: 'unauthorized', reason: 'token-invalid' }
      }

      const code = errcode === undefined ? 'failed' : mapErrcode(errcode)
      deps.log.warn('im-push-failed', { reason: code, errcode, status: response.status })
      return { ok: false, code, reason: code }
    }
    return { ok: false, code: 'failed', reason: 'retry-exhausted' }
  }
}

/**
 * 生产用 HTTP 实现（Node 内置 `fetch`）。
 *
 * 体解析失败时保留原文：微信异常时可能回 HTML/空体，直接抛会让上层丢掉状态码。
 */
export function createNodeFetchJson(): FetchJson {
  return async (url, init) => {
    const response = await fetch(url, {
      method: init?.method ?? 'GET',
      ...(init?.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text) as unknown
    } catch {
      // 非 JSON 响应（微信网关异常/空体）：保留原文，交由 errcodeOf 判 undefined
    }
    return { status: response.status, body }
  }
}
