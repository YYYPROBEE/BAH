/**
 * 传输层：一条 SSE 下行 + 四条 POST 上行（`docs/web-frontend.md` §7）。
 *
 * 设计上刻意"薄"：解析、重连、错误横幅之外什么都不做。
 * 好处是 `main.js` 里没有 `fetch` 调用——测试可以整体替换 `transport`，
 * 不需要起真实服务（T-WEB-008 的"独立运行"就是这样验的）。
 */

/**
 * HTTP 客户端。
 *
 * @param {{ base?: string }} [options]
 */
export function createHttpApi(options = {}) {
  const base = options.base ?? ''

  /** 发一个 JSON 请求；非 2xx 不抛，返回结构化结果（界面按 `code` 决定文案）。 */
  async function request(method, path, body) {
    const init = { method, headers: {} }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    let response
    try {
      response = await fetch(`${base}${path}`, init)
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
      const code = data?.error?.code ?? `http-${response.status}`
      const reason = data?.error?.reason ?? `请求失败（${response.status}）`
      return { ok: false, status: response.status, code, reason }
    }
    return { ok: true, status: response.status, data }
  }

  return {
    session: () => request('GET', '/api/session'),
    health: () => request('GET', '/api/health'),
    turn: (text) => request('POST', '/api/turn', { text }),
    interrupt: (reason) => request('POST', '/api/interrupt', { reason }),
    decide: (ticketId, decision, reason) =>
      request('POST', `/api/approval/${encodeURIComponent(ticketId)}`, reason === undefined
        ? { decision }
        : { decision, reason }),
    verify: (ticketId) => request('POST', `/api/verify/${encodeURIComponent(ticketId)}`),
  }
}

/**
 * 连 SSE。
 *
 * 断线由浏览器 `EventSource` 自动重连（同一 URL）。服务端每次连接都先发**全量快照**，
 * 所以"重连后 since 过期"不会造成半新半旧——快照整体替换。
 *
 * @param {{
 *   since?: number,
 *   onFrame: (frame: unknown) => void,
 *   onFault?: (fault: { code: string, reason: string }) => void,
 *   onStatus?: (status: 'online'|'offline') => void,
 * }} options
 */
export function connectEvents(options) {
  const since = options.since ?? 0
  const source = new EventSource(`/api/events?since=${String(since)}`)

  const handleFrame = (event) => {
    try {
      options.onFrame(JSON.parse(event.data))
    } catch {
      // 一帧坏掉不能打断整个流：丢掉这一帧，连接继续
    }
  }

  const handleFault = (event) => {
    try {
      options.onFault?.(JSON.parse(event.data))
    } catch {
      options.onFault?.({ code: 'fault-unparsable', reason: String(event.data) })
    }
  }

  source.addEventListener('frame', handleFrame)
  source.addEventListener('fault', handleFault)
  source.addEventListener('open', () => options.onStatus?.('online'))
  source.addEventListener('error', () => options.onStatus?.('offline'))

  return {
    close() {
      source.removeEventListener('frame', handleFrame)
      source.removeEventListener('fault', handleFault)
      source.close()
    },
  }
}
