/**
 * 传输层：一条 SSE 下行 + 四条 POST 上行（`docs/web-frontend.md` §7）。
 *
 * 设计上刻意"薄"：解析、重连、错误横幅之外什么都不做。
 * 好处是 `main.js` 里没有 `fetch` 调用——测试可以整体替换 `transport`，
 * 不需要起真实服务（T-WEB-008 的"独立运行"就是这样验的）。
 */

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
    // 观测面板（03）：GET 只读，不参与 CSRF；`?format=chrome` 留给 CLI/curl，UI 不用。
    metrics: () => request('GET', '/api/metrics'),
    trace: (query = {}) => {
      const search = new URLSearchParams({ limit: String(query.limit ?? 2000) })
      if (query.format !== undefined) search.set('format', String(query.format))
      return request('GET', `/api/trace?${search.toString()}`)
    },
  }
}

/**
 * 会话控制端点（04 单）：人工接管 / 交回 / "回到上一步"分叉。
 *
 * 为什么放在 transport.js 而不是移动壳里自造 fetch：token 与 CSRF 的读取面只许有一处
 * （门禁 `verify-mobile-shell` 的 I5/I10）——两份实现迟早会在安全头上漂。
 *
 * @param {{ base?: string, token?: string, csrfToken?: string }} [options]
 */
export function createSessionControlClient(options = {}) {
  const base = options.base ?? ''
  const token = options.token ?? readWebToken()
  const csrfToken = options.csrfToken ?? readCookie('bah_csrf')

  async function send(method, path, body) {
    const headers = { authorization: `Bearer ${token}` }
    if (method !== 'GET') headers['x-bah-csrf'] = csrfToken
    const init = { method, headers }
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
    handoffStatus: () => send('GET', '/api/handoff'),
    handoff: (reason) => send('POST', '/api/handoff', reason === undefined ? {} : { reason }),
    resume: () => send('POST', '/api/handoff/resume', {}),
    fork: (turn) => send('POST', '/api/session/fork', { turn }),
  }
}

/**
 * 连 SSE（`docs/web-frontend.md` §8）。
 *
 * 续订点必须跟着**已归约的最大 seq** 走：`EventSource` 自带重连，但重连 URL 不会更新，
 * 于是每次断线都会回到 `since=0`。这里改为手动重连——关掉旧连接、按 1s 退避重开，
 * URL 里的 `since` 用本端推进后的 `maxSeq`（服务端仍发全量快照，快照帧带 `maxSeq`）。
 *
 * `base` 与 `createHttpApi` 对齐：桌面壳 / 跨源静态站下 REST 与 SSE 必须指向同一个源。
 *
 * `EventSource` 不能自定义请求头，token 只能走查询参数（仅本接口接受）。
 *
 * @param {{
 *   base?: string,
 *   since?: number,
 *   token?: string,
 *   retryDelayMs?: number,
 *   maxRetries?: number,
 *   onFrame: (frame: unknown) => void,
 *   onFault?: (fault: { code: string, reason: string }) => void,
 *   onStatus?: (status: 'online'|'offline') => void,
 * }} options
 */
export function connectEvents(options) {
  const base = options.base ?? ''
  const token = options.token ?? readWebToken()
  const query = token === '' ? '' : `&token=${encodeURIComponent(token)}`
  const retryDelayMs = options.retryDelayMs ?? 1000
  const maxRetries = options.maxRetries ?? 10

  /** 已收到帧里的最大 seq（续订点）。 */
  let maxSeq = options.since ?? 0
  let attempts = 0
  let source = null
  let timer = null
  let closed = false

  /** 推进一步续订点（`snapshot` 带 `maxSeq`，其余帧带 `seq`）。 */
  const remember = (frame) => {
    const seq = typeof frame?.maxSeq === 'number' ? frame.maxSeq : frame?.seq
    if (typeof seq === 'number' && Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
  }

  const handleFrame = (event) => {
    try {
      const frame = JSON.parse(event.data)
      remember(frame)
      options.onFrame(frame)
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

  const handleOpen = () => {
    attempts = 0
    options.onStatus?.('online')
  }

  const handleError = () => {
    options.onStatus?.('offline')
    scheduleReconnect()
  }

  /** 关掉当前连接并摘掉四个监听（不复用：旧连接的事件不能再进来）。 */
  function detach() {
    if (source === null) return
    source.removeEventListener('frame', handleFrame)
    source.removeEventListener('fault', handleFault)
    source.removeEventListener('open', handleOpen)
    source.removeEventListener('error', handleError)
    source.close()
    source = null
  }

  /** 退避重连：1s 一次，最多 `maxRetries` 次（放弃后状态停在"已断开"）。 */
  function scheduleReconnect() {
    if (closed || timer !== null) return
    if (attempts >= maxRetries) return
    attempts += 1
    detach()
    timer = setTimeout(() => {
      timer = null
      open()
    }, retryDelayMs)
  }

  function open() {
    if (closed) return
    const next = new EventSource(`${base}/api/events?since=${String(maxSeq)}${query}`)
    source = next
    next.addEventListener('frame', handleFrame)
    next.addEventListener('fault', handleFault)
    next.addEventListener('open', handleOpen)
    next.addEventListener('error', handleError)
  }

  open()

  return {
    close() {
      closed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      detach()
    },
  }
}
