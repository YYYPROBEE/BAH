/**
 * 交易密码安全页（ADR-0014）。
 *
 * ## 这条链路为什么不经过模型
 *
 * 工具 `password_change(action="request")` 只签一张一次性交接票据（`pwd:<callId>`，120s）并把
 * 用户送到本页；密码在**本页的表单里**提交给 `POST /api/secure/password`。会话日志只留
 * `security/password-changed { userId, method, at }`，一个字都不沾密码。
 *
 * ## 四条硬纪律
 *
 * 1. **密码不落任何存储**：不写 `localStorage` / `sessionStorage` / cookie，不发 `console.*`
 *    （与登录卡片的 A1 同一条）。
 * 2. **票据号可以进 URL，密码不行**：票据是一次性、120 秒有效的短期凭证，读取后立刻用
 *    `history.replaceState` 从地址栏抹掉，避免留在浏览历史里。
 * 3. **不回显**：成功后清空两个输入框，只显示"已修改 + 时刻"。
 * 4. **纯原生 JS**（`verify-web` 禁框架 / 禁 CDN）。
 */

import { el } from './dom.js'

/** CSRF double-submit 的 cookie 名（与 `web/csrf.ts` 同源）。 */
const CSRF_COOKIE = 'bah_csrf'
/** Web token 的 meta 名（static 鉴权模式下由服务端注入）。 */
const WEB_TOKEN_META = 'bah-web-token'
/** 交接票据的查询参数名。 */
const TICKET_QUERY = 'ticket'

/**
 * 服务端理由码 → 人话（封闭表）。
 *
 * 表外的一律走 `STATUS_TEXT`：宁可说"服务端拒绝了这次提交"，也不要猜一个可能误导的说法。
 * 注意 `password-mismatch` 的文案：它**不**提示"是第几位错了"——服务端也不告诉它。
 */
const CODE_TEXT = {
  'web-invalid-ticket': '票据号缺失或格式不正确，请回到对话里重新发起改密。',
  'password-invalid': '新密码不符合要求：8–20 位，必须同时包含字母与数字，且不能与旧密码相同。',
  'password-mismatch': '旧交易密码不正确（票据仍然有效，可以再试一次）。',
  'password-locked': '连续错误次数过多，交易密码已临时锁定，请稍后再试。',
  'password-ticket-unknown': '票据号不存在，请回到对话里重新发起改密。',
  'password-ticket-foreign': '票据号不存在或不属于当前会话，请回到对话里重新发起改密。',
  'password-ticket-expired': '票据已过期（有效期 120 秒），请回到对话里重新发起改密。',
  'password-ticket-used': '这张票据已经用过了，改密票据是一次性的。',
  'no-identity': '当前会话还没有绑定客户身份，请先回到首页登录。',
  'password-handoff-unavailable': '本部署没有装配交易密码能力。',
}

/** 状态码兜底文案（理由码不在表里时用）。 */
const STATUS_TEXT = {
  400: '提交被拒绝：请检查票据号与两个密码框。',
  401: '登录状态已失效，请先回到首页重新登录。',
  403: '没有权限执行改密（缺少会话凭证或 CSRF 令牌）。',
  404: '票据号不存在或不属于当前会话。',
  409: '票据已过期或已被使用，请重新发起改密。',
  423: '交易密码处于锁定状态，请稍后再试。',
  501: '本部署没有装配交易密码能力。',
}

/** 读 cookie（CSRF double-submit 需要同源脚本回填请求头）。 */
function readCookie(name) {
  if (typeof document === 'undefined') return ''
  for (const part of String(document.cookie ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return ''
}

/** 读服务端注入的 meta（读不到返回空串）。 */
function readMeta(name) {
  if (typeof document === 'undefined') return ''
  const meta = document.querySelector(`meta[name="${name}"]`)
  return meta?.getAttribute('content') ?? ''
}

/** 一次提交（不抛；返回 `{ ok, status, data }`）。 */
async function submitChange(ticketId, oldPassword, newPassword) {
  const headers = { 'content-type': 'application/json' }
  const csrf = readCookie(CSRF_COOKIE)
  if (csrf !== '') headers['x-bah-csrf'] = csrf
  const token = readMeta(WEB_TOKEN_META)
  if (token !== '') headers.authorization = `Bearer ${token}`
  try {
    const response = await fetch('/api/secure/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ ticketId, oldPassword, newPassword }),
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    return { ok: response.ok, status: response.status, data }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}

/** `me` 探测（password 模式才需要；static 模式没有这个接口语义）。 */
async function fetchMe() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' })
    return { ok: response.ok, status: response.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

/** 失败文案：先按理由码，再按状态码，最后一句兜底。 */
function failureText(result) {
  const code = result.data?.error?.code
  if (typeof code === 'string' && CODE_TEXT[code] !== undefined) return CODE_TEXT[code]
  const byStatus = STATUS_TEXT[result.status]
  if (byStatus !== undefined) return byStatus
  return '提交失败（服务端未给出可识别的理由），请稍后重试。'
}

/** 渲染表单并接管提交流程。 */
function render(root, ticketFromQuery) {
  const ticket = el('input', {
    class: 'ds-input',
    type: 'text',
    name: 'ticketId',
    autocomplete: 'off',
    inputmode: 'text',
    placeholder: '交接票据号（形如 pwd:c-12）',
    required: 'true',
    value: ticketFromQuery,
  })
  const oldPassword = el('input', {
    class: 'ds-input',
    type: 'password',
    name: 'oldPassword',
    autocomplete: 'current-password',
    placeholder: '当前交易密码',
    required: 'true',
  })
  const newPassword = el('input', {
    class: 'ds-input',
    type: 'password',
    name: 'newPassword',
    autocomplete: 'new-password',
    placeholder: '新交易密码（8–20 位，含字母与数字）',
    required: 'true',
  })
  const message = el('p', {
    class: 'ds-hint',
    role: 'alert',
    'aria-live': 'assertive',
    hidden: 'true',
  })
  const submit = el('button', { class: 'ds-btn ds-btn--primary', type: 'submit', text: '确认修改' })

  const form = el('form', { class: 'login-card' }, [
    el('h1', { class: 'login-card__title', text: '修改交易密码' }),
    el('p', {
      class: 'login-card__hint',
      text: '密码只在这一页提交，不会进入对话记录，也不会被助手看到。',
    }),
    el('label', { class: 'ds-label', text: '交接票据号' }),
    ticket,
    el('label', { class: 'ds-label', text: '当前交易密码' }),
    oldPassword,
    el('label', { class: 'ds-label', text: '新交易密码' }),
    newPassword,
    message,
    submit,
    el('p', { class: 'login-card__hint' }, [el('a', { href: '/', text: '返回对话' })]),
  ])

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submit.disabled = true
    message.hidden = true
    const result = await submitChange(ticket.value.trim(), oldPassword.value, newPassword.value)
    submit.disabled = false
    message.hidden = false
    if (result.ok) {
      // 成功后**立刻清空**两个密码框：句柄还在页面上，不清就等于留了一份明文
      oldPassword.value = ''
      newPassword.value = ''
      const at = Number(result.data?.changedAt ?? 0)
      const when = Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : '刚刚'
      message.textContent = `交易密码已修改（${when}）。本次票据已失效，如需再改请重新发起。`
      return
    }
    message.textContent = failureText(result)
    oldPassword.focus()
    oldPassword.select()
  })

  root.replaceChildren(el('div', { class: 'login' }, [form]))
  queueMicrotask(() => (ticketFromQuery !== '' ? oldPassword : ticket).focus())
}

/** 入口：读票据号 → （password 模式）确认登录态 → 渲染表单。 */
export async function startSecurePasswordPage() {
  const root = document.getElementById('secure-password')
  if (root === null) return

  // 票据号可以进 URL（一次性、120 秒），但读出来就立刻抹掉，别留在浏览历史里
  const params = new URLSearchParams(window.location.search)
  const ticketFromQuery = params.get(TICKET_QUERY) ?? ''
  if (ticketFromQuery !== '') {
    params.delete(TICKET_QUERY)
    const rest = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (rest === '' ? '' : `?${rest}`))
  }

  // password 模式：401 时直接说"先登录"（比让用户填完表单再吃一个 403 好）
  if (readMeta('bah-auth-mode') === 'password') {
    const me = await fetchMe()
    if (!me.ok) {
      root.replaceChildren(
        el('div', { class: 'login' }, [
          el('p', { class: 'ds-hint', role: 'alert', text: CODE_TEXT['no-identity'] }),
          el('p', { class: 'login-card__hint' }, [el('a', { href: '/', text: '去首页登录' })]),
        ]),
      )
      return
    }
  }

  render(root, ticketFromQuery)
}

if (typeof document !== 'undefined') {
  void startSecurePasswordPage()
}
