/**
 * 传输层：一条 SSE 下行 + 四条 POST 上行（`docs/web-frontend.md` §7）。
 *
 * 设计上刻意"薄"：解析、重连、错误横幅之外什么都不做。
 * 好处是 `main.js` 里没有 `fetch` 调用——测试可以整体替换 `transport`，
 * 不需要起真实服务（T-WEB-008 的"独立运行"就是这样验的）。
 */

import { readAuthMode } from './auth.js'

/**
 * 从页面读取服务端注入的访问 token。
 *
 * 服务端每个进程生成/读取一个 token 并写进 index.html 的 meta；
 * 跨源页面读不到这个响应体，所以它同时充当最小 CSRF 边界。
 *
 * @returns {string} 没有 meta 时返回空串（测试装置与桌面壳可注入自己的 api）
 */
function readWebToken() {
  if (typeof document === 'undefined') return ''
  const meta = document.querySelector('meta[name="bah-web-token"]')
  return meta?.getAttribute('content') ?? ''
}

/**
 * 从 cookie 读 CSRF 令牌（W09 double-submit）。
 *
 * 服务端在 index.html 响应里下发 `bah_csrf`（非 HttpOnly），前端把它回填到
 * `x-bah-csrf` 请求头；跨站脚本既读不到同源响应体，也读不到这条 cookie。
 *
 * @param {string} name
 * @returns {string} 没有 cookie 时返回空串
 */
function readCookie(name) {
  if (typeof document === 'undefined') return ''
  for (const part of String(document.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return ''
}

/**
 * HTTP 客户端。
 *
 * @param {{ base?: string, token?: string }} [options]
 */
export function createHttpApi(options = {}) {
  const base = options.base ?? ''
  const token = options.token ?? readWebToken()
  const csrfToken = options.csrfToken ?? readCookie('bah_csrf')

  /** 发一个 JSON 请求；非 2xx 不抛，返回结构化结果（界面按 `code` 决定文案）。 */
  async function request(method, path, body) {
    const init = { method, headers: {} }
    if (token !== '') init.headers.authorization = `Bearer ${token}`
    if (method !== 'GET' && csrfToken !== '') init.headers['x-bah-csrf'] = csrfToken
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
      // 会话失效（401）不是"某一次操作失败"：交给登录门统一收敛（password 模式才有监听者；
      // static 模式下没人听，等于什么都不发生——保持改动前行为）。
      if (response.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('bah:unauthorized'))
      }
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
 * `EventSource` 不能自定义请求头，token 只能走查询参数（仅本接口接受）。
 *
 * @param {{
 *   since?: number,
 *   token?: string,
 *   onFrame: (frame: unknown) => void,
 *   onFault?: (fault: { code: string, reason: string }) => void,
 *   onStatus?: (status: 'online'|'offline') => void,
 * }} options
 */
export function connectEvents(options) {
  const since = options.since ?? 0
  const token = options.token ?? readWebToken()
  const query = token === '' ? '' : `&token=${encodeURIComponent(token)}`
  const source = new EventSource(`/api/events?since=${String(since)}${query}`)

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
  // password 模式下会话来失效时，SSE 连接会收到 401；而 `EventSource` 拿不到状态码，
  // 默认行为是每几秒自动重连一次（重连风暴）。用一次 `/api/auth/me` 探测，失效就显式
  // `close()` 并交回登录门（整页刷新）——这就是 TA-31 的"丢弃当前 SSE 连接"。
  let probing = false
  source.addEventListener('error', () => {
    options.onStatus?.('offline')
    if (probing || typeof fetch !== 'function' || readAuthMode() !== 'password') return
    probing = true
    void fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((response) => {
        if (response.status === 401) {
          source.close()
          window.dispatchEvent(new CustomEvent('bah:unauthorized'))
        }
      })
      .catch(() => undefined)
      .finally(() => {
        probing = false
      })
  })

  return {
    close() {
      source.removeEventListener('frame', handleFrame)
      source.removeEventListener('fault', handleFault)
      source.close()
    },
  }
}
