/**
 * 坐席台 HTTP 客户端（B2）。
 *
 * 七个调用一一对应 01 的路由；**不做乐观渲染**、不改状态，只把结果原样交回。
 * 凭证来自 `gate`（sessionStorage），不放 URL；CSRF 走同源 `Origin`（浏览器自动带）。
 */

import { OPERATOR_TOKEN_KEY } from './gate.js'

/**
 * @param {{ token: string, base?: string, fetchImpl?: typeof fetch }} options
 */
export function createSeatApi(options) {
  const base = options.base ?? ''
  const token = options.token
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)

  /**
   * 发一个 JSON 请求；非 2xx 返回结构化结果（含 `status`，调用方据此区分 401）。
   *
   * @returns {Promise<{ok: true, status: number, data: any} | {ok: false, status: number, code: string, reason: string}>}
   */
  async function request(method, path, body) {
    const init = { method, headers: { authorization: `Bearer ${token}` } }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    let response
    try {
      response = await doFetch(`${base}${path}`, init)
    } catch (error) {
      return { ok: false, status: 0, code: 'network-error', reason: String(error) }
    }

    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: data?.error?.code ?? `http-${String(response.status)}`,
        reason: data?.error?.reason ?? `请求失败（${String(response.status)}）`,
      }
    }
    return { ok: true, status: response.status, data }
  }

  return {
    /** 读摘要（也用于验证凭证是否有效：401 = 无效/已轮换）。 */
    handoff: () => request('GET', '/api/handoff'),
    /** 请求接管（客户动作；坐席台默认不提供按钮，保留 API 供运营脚本）。 */
    enter: (reason) =>
      request('POST', '/api/handoff', reason === undefined ? {} : { reason }),
    /** 认领（幂等；换人 409）。 */
    claim: () => request('POST', '/api/handoff/claim'),
    /** 人工发言（落领域事件，不进模型历史）。 */
    say: (text) => request('POST', '/api/handoff/message', { text }),
    /** 交回（handover 为空时不落 user/message）。 */
    resume: (handover) =>
      request(
        'POST',
        '/api/handoff/resume',
        typeof handover === 'string' && handover.trim() !== '' ? { handover } : {},
      ),
    /** 等待时长 / 超时判定（服务端权威值）。 */
    heartbeat: () => request('POST', '/api/handoff/heartbeat'),
    /** 单会话队列（depth ∈ {0,1}）。 */
    queue: () => request('GET', '/api/handoff/queue'),
  }
}

/** 与 `gate.js` 共用同一个 key（测试可核对"凭证只存这里"）。 */
export { OPERATOR_TOKEN_KEY }
