/**
 * 登录态与登录卡片（租户与鉴权 02 · TA-28 / TA-31）。
 *
 * ## 什么时候会有这张卡片
 *
 * 服务端在 `index.html` 注入 `<meta name="bah-auth-mode" content="…">`：
 * - `password` → 先 `GET /api/auth/me`；401 就渲染登录卡片，200 才挂主界面；
 * - `static` / `none` / 没有 meta → **完全不动**（改动前的行为，快照与 web 用例靠它）。
 *
 * ## 三条纪律
 *
 * 1. **纯原生 JS**（`verify-web` 禁框架、禁 CDN）；
 * 2. **任何 401 只有一种表现**：回登录卡片，不出现"白屏 + console 报错"；
 * 3. **口令只 POST 一次、不落任何存储**（不写 localStorage/sessionStorage，A1）。
 */

import { BRAND } from './brand.js'
import { el } from './dom.js'

/** 登录态失败时的统一文案（A2：不给"用户不存在"）。 */
const FAILED_TEXT = '账号或口令不正确'

/** 读服务端注入的认证模式（读不到返回空串 = 改动前行为）。 */
export function readAuthMode() {
  if (typeof document === 'undefined') return ''
  const meta = document.querySelector('meta[name="bah-auth-mode"]')
  return meta?.getAttribute('content') ?? ''
}

/** 读 cookie（登录请求要带 CSRF 的 double-submit）。 */
function readCookie(name) {
  if (typeof document === 'undefined') return ''
  for (const part of String(document.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return ''
}

/** 发一个同源 JSON 请求（带上 CSRF 头；不抛，返回 `{ok,status,data}`）。 */
async function postJson(path, body) {
  const csrf = readCookie('bah_csrf')
  const headers = { 'content-type': 'application/json' }
  if (csrf !== '') headers['x-bah-csrf'] = csrf
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(body),
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    // 锁定回包带 `retry-after`（服务端按 IP 锁 15 分钟）：只说"稍后再试"等于不给时间。
    const rawRetry = response.headers.get('retry-after')
    const retryAfterSec = rawRetry === null ? undefined : Number(rawRetry)
    return {
      ok: response.ok,
      status: response.status,
      data,
      ...(typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? { retryAfterSec }
        : {}),
    }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}

/** 锁定提示：把秒折算成"X 分钟 / X 秒后"。 */
function lockedText(retryAfterSec) {
  if (typeof retryAfterSec !== 'number') return '尝试过于频繁，请稍后再试'
  if (retryAfterSec >= 60) return `尝试过于频繁，请 ${String(Math.ceil(retryAfterSec / 60))} 分钟后再试`
  return `尝试过于频繁，请 ${String(retryAfterSec)} 秒后再试`
}

/** `GET /api/auth/me`（不抛）。 */
export async function fetchMe() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' })
    if (!response.ok) return { ok: false, status: response.status, data: null }
    return { ok: true, status: response.status, data: await response.json() }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}

/**
 * 渲染登录卡片。
 *
 * @param {{ onAuthenticated: () => void }} options
 * @returns {HTMLElement}
 */
export function renderLoginCard(options) {
  const userId = el('input', {
    class: 'ds-input',
    type: 'text',
    name: 'userId',
    autocomplete: 'username',
    placeholder: '客户号（如 u-1）',
    required: 'true',
  })
  const password = el('input', {
    class: 'ds-input',
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
    placeholder: '口令',
    required: 'true',
  })
  // `role=alert` + `aria-live`：错误提示不能只有视觉，屏读也必须播报（P2-7）。
  const message = el('p', { class: 'ds-hint', role: 'alert', 'aria-live': 'assertive', hidden: 'true' })
  const submit = el('button', { class: 'ds-btn ds-btn--primary', type: 'submit', text: '登录' })

  const form = el('form', { class: 'login-card' }, [
    el('h1', { class: 'login-card__title', text: BRAND.name }),
    el('p', { class: 'login-card__hint', text: '请使用客户号与口令登录' }),
    userId,
    password,
    message,
    submit,
  ])

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submit.disabled = true
    message.hidden = true
    const result = await postJson('/api/auth/login', {
      userId: userId.value.trim(),
      password: password.value,
    })
    submit.disabled = false
    if (result.ok) {
      // 登录成功后**重建**整个界面（旧的 api/SSE 是匿名态建的）
      options.onAuthenticated()
      return
    }
    // 409 = 锁定（按 `retry-after` 给剩余时间），其余一律同一句（不区分"用户不存在"与"口令错"）
    message.hidden = false
    message.textContent = result.status === 409 ? lockedText(result.retryAfterSec) : FAILED_TEXT
    // TA-31 第 2 步：出错**不清空**字段（只选中，方便直接重输）
    password.focus()
    password.select()
  })

  const card = el('div', { class: 'login' }, [form])
  queueMicrotask(() => userId.focus())
  return card
}

/**
 * 密码模式的启动门。
 *
 * @param {{ root: HTMLElement, mount: () => void }} options
 */
export async function bootstrapPasswordGate(options) {
  const { root, mount } = options
  // 会话在界面打开期间失效（cookie 被删、过期、被撤销）：任何 API 401 都回登录卡片。
  // 用整页刷新而不是原地换 DOM：挂载后的 SSE、定时器、控制器都持有匿名态闭包，
  // 原地换 DOM 会留下一个"看着是登录卡片、后台还连着流"的假状态。
  window.addEventListener('bah:unauthorized', () => window.location.reload())
  const me = await fetchMe()
  if (me.ok) {
    mount()
    return
  }
  root.replaceChildren(
    renderLoginCard({
      onAuthenticated: () => {
        root.replaceChildren()
        mount()
      },
    }),
  )
}

/** 退出登录：POST 后把界面交回登录卡片（失败也回——本地状态不可信）。 */
export async function logout() {
  await postJson('/api/auth/logout', {})
  if (typeof window !== 'undefined') window.location.reload()
}
