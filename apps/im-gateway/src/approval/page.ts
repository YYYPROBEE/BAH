/**
 * H5 审批页。
 *
 * 安全纪律（T-H5-001）：
 * 1. **零远程资源**：CSS/JS 都从网关自身 `/assets/*` 出；CSP `default-src 'none'`；
 * 2. **不注入 JSON / 内联脚本**：token 从 `location.pathname` 取，页面只用 data 属性；
 * 3. **所有动态字段转义**；页面不写 cookie、不读 localStorage；
 * 4. **一次性**：POST 前先 claim 链接（并发双击只有一个能提交）。
 *
 * 一切结论仍以子进程返回为准：页面只负责渲染与转发。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'

import { IM_COMMAND_MAX_REASON, verifyApprovalLink } from '@bah/channels'

import type { ChildCallResult } from '../session/client.ts'
import type { GatewayConfig } from '../config.ts'
import type { ImLogger } from '../log.ts'
import type { SessionHub } from '../session/hub.ts'
import type { Supervisor } from '../session/supervisor.ts'

import type { PendingTicket } from './pending.ts'
import {
  ALREADY_DECIDED_TEXT,
  EXPIRED_TEXT,
  FOREIGN_TICKET_TEXT,
  INVALID_DECISION_TEXT,
  NO_CHALLENGE_TEXT,
  REASON_REQUIRED_TEXT,
  UNKNOWN_TICKET_TEXT,
  VERIFY_FAILED_TEXT,
} from './texts.ts'

/** 页面安全头（固定串，门禁 G9 逐字比对）。 */
export const H5_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/** H5 JSON 响应头（同安全头 + JSON 类型）。 */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  ...H5_SECURITY_HEADERS,
  'content-type': 'application/json; charset=utf-8',
}

/** 链接一次性记录 TTL（10 分钟）。 */
export const USED_LINK_TTL_MS = 10 * 60 * 1000

/** H5 模板 / 静态资源（模块加载时读一次；资源随源码发布）。 */
const TEMPLATE = readAsset('approve.html')
const CSS = readAsset('approve.css')
const JS = readAsset('approve.js')

/** 读 `apps/im-gateway/assets/<name>`（相对本文件两级）。 */
function readAsset(name: string): string {
  try {
    return readFileSync(new URL(`../../assets/${name}`, import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

/** HTML 转义（所有动态字段必须经过它）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 链接一次性存储（sha256 键，TTL 10 分钟）。 */
export interface UsedLinkStore {
  /** 标记并返回"是否是第一次"（并发双击只有一个 true）。 */
  claim(token: string): boolean
}

/** 造一个一次性存储。 */
export function createUsedLinkStore(options: { readonly nowMs: () => number }): UsedLinkStore {
  const used = new Map<string, number>()
  return {
    claim(token: string): boolean {
      const now = options.nowMs()
      for (const [key, at] of used) {
        if (now - at > USED_LINK_TTL_MS) used.delete(key)
      }
      const key = createHash('sha256').update(token).digest('hex')
      if (used.has(key)) return false
      used.set(key, now)
      return true
    },
  }
}

/** H5 依赖。 */
export interface ApprovalPageDeps {
  readonly config: GatewayConfig
  readonly hub: SessionHub
  readonly supervisor: Supervisor
  readonly log: ImLogger
  readonly usedLinks: UsedLinkStore
  readonly nowMs?: () => number
}

/** 写 HTML（安全头固定）。 */
function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    ...H5_SECURITY_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

/** 写 JSON。 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 错误响应体（与子进程同形）。 */
function errorBody(code: string, reason: string): unknown {
  return { error: { code, reason } }
}

/** 令牌哈希前 8 位（日志用；不落 token 原文）。 */
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}

/** 层级标签。 */
function tierLabel(tier: PendingTicket['tier']): string {
  switch (tier) {
    case 'green':
      return '低风险'
    case 'yellow':
      return '中风险'
    case 'red':
      return '高风险'
    case 'unknown':
      return '未标注'
    default:
      return '未标注'
  }
}

/**
 * 渲染票据详情（全部字段转义）。
 *
 * 有 `details`（服务端签发的操作明细）时，金额与收款人**只从明细出**：
 * 摘要行与明细行并列同一笔钱，出现分歧时用户无从判断该信哪个。
 *
 * 导出给用例直接断言渲染结果（不必起 HTTP）：它是纯函数，输入 `PendingTicket`，
 * 输出一段已转义的 HTML。
 */
export function ticketContent(ticket: PendingTicket): string {
  const rows: string[] = []
  const details = ticket.details ?? []
  const hasDetails = details.length > 0
  rows.push(`<h1>${escapeHtml(ticket.operation)}</h1>`)
  rows.push('<dl class="facts">')
  if (!hasDetails) {
    rows.push(`<dt>金额</dt><dd>${escapeHtml(ticket.amountText ?? '待确认')}</dd>`)
    if (ticket.payeeName !== undefined) {
      rows.push(`<dt>收款人</dt><dd>${escapeHtml(ticket.payeeName)}</dd>`)
    }
  }
  rows.push(`<dt>层级</dt><dd>${escapeHtml(tierLabel(ticket.tier))}</dd>`)
  if (ticket.expiresAt !== undefined) {
    rows.push('<dt>剩余时间</dt><dd><span id="countdown">计算中…</span></dd>')
  }
  rows.push('</dl>')

  if (hasDetails) {
    rows.push('<h2 class="details-title">执行明细</h2>')
    rows.push('<dl class="facts details">')
    for (const detail of details) {
      // 强调只改字体/颜色（`amount` 等宽、`risk` 警示色），不做左侧色条
      const cls =
        detail.emphasis === undefined ? '' : ` class="detail-${escapeHtml(detail.emphasis)}"`
      rows.push(`<dt>${escapeHtml(detail.label)}</dt><dd${cls}>${escapeHtml(detail.value)}</dd>`)
    }
    rows.push('</dl>')
  }

  if (ticket.tier === 'red' || ticket.challenge !== undefined) {
    rows.push('<p class="notice">该票据需要强验证。请先完成验证，再批准。</p>')
    if (!ticket.verified) rows.push('<button type="button" id="verify">强验证</button>')
  }
  rows.push('<label class="reason"><span>拒绝理由（拒绝时必填）</span>')
  rows.push('<textarea id="reason" maxlength="500" rows="3"></textarea></label>')
  rows.push('<div class="actions">')
  rows.push(
    `<button type="button" id="approve"${(ticket.tier === 'red' || ticket.challenge !== undefined) && !ticket.verified ? ' disabled' : ''}>批准一次</button>`,
  )
  rows.push('<button type="button" id="reject" class="secondary">拒绝</button>')
  rows.push('</div>')
  rows.push('<p id="status" class="status" role="status"></p>')
  return rows.join('\n')
}

/** 渲染壳（模板占位符只有三处；不注入 JSON）。 */
function renderShell(input: {
  readonly tier: string
  readonly expiresAt?: number
  readonly content: string
}): string {
  return TEMPLATE.replaceAll('{{TIER}}', escapeHtml(input.tier))
    .replaceAll('{{EXPIRES_AT}}', input.expiresAt === undefined ? '' : String(input.expiresAt))
    .replaceAll('{{CONTENT}}', input.content)
}

/** 不可用页（票据已处理 / 状态未知）。 */
function unavailablePage(): string {
  return renderShell({
    tier: 'unavailable',
    content: '<h1>票据已处理或状态未知</h1><p>请回到对话查看最新结果。</p>',
  })
}

/** 链接错误页。 */
function linkErrorPage(message: string): string {
  return renderShell({ tier: 'unavailable', content: `<h1>${escapeHtml(message)}</h1>` })
}

/** 校验 token；失败时写错误页并返回 `undefined`。 */
function verifiedPayloadOf(
  token: string,
  res: ServerResponse,
  deps: ApprovalPageDeps,
): { readonly s: string; readonly t: string } | undefined {
  const now = deps.nowMs?.() ?? Date.now()
  const verdict = verifyApprovalLink(token, deps.config.linkSecret, now)
  if (!verdict.ok) {
    deps.log.warn('im-h5-token-rejected', { code: verdict.code, tokenHash8: tokenDigest(token) })
    const status = verdict.code === 'expired' ? 410 : 403
    writeHtml(res, status, linkErrorPage(verdict.code === 'expired' ? '链接已过期' : '链接无效'))
    return undefined
  }
  return { s: verdict.payload.s, t: verdict.payload.t }
}

/**
 * `GET /a/:token`：打开审批页。
 */
export function handleApproveGet(
  token: string,
  res: ServerResponse,
  deps: ApprovalPageDeps,
): void {
  const payload = verifiedPayloadOf(token, res, deps)
  if (payload === undefined) return

  const ticket = deps.hub.pendingGet(payload.s, payload.t)
  const record = deps.supervisor.get(payload.s)
  if (ticket === undefined || record === undefined || record.status !== 'ready') {
    deps.log.info('im-h5-open', { tokenHash8: tokenDigest(token), state: 'unavailable' })
    writeHtml(res, 200, unavailablePage())
    return
  }

  deps.log.info('im-h5-open', { tokenHash8: tokenDigest(token), ticketId: ticket.ticketId })
  writeHtml(res, 200, renderShell({ tier: ticket.tier, ...(ticket.expiresAt === undefined ? {} : { expiresAt: ticket.expiresAt }), content: ticketContent(ticket) }))
}

/** 从子进程结果里取 code / reason（优先已解析 JSON；读不出来给兜底）。 */
function childErrorOf(result: ChildCallResult): { readonly code: string; readonly reason: string } {
  const parsed = result.json ?? (() => {
    try {
      return JSON.parse(result.text) as unknown
    } catch {
      return undefined
    }
  })()
  if (typeof parsed !== 'object' || parsed === null) return { code: 'failed', reason: '处理失败' }
  const error = (parsed as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return { code: 'failed', reason: '处理失败' }
  const code = (error as { code?: unknown }).code
  const reason = (error as { reason?: unknown }).reason
  return {
    code: typeof code === 'string' ? code : 'failed',
    reason: typeof reason === 'string' ? reason : '处理失败',
  }
}

/** H5 的状态码 → 用户可见理由（不把内部码原样透出去之外的包装）。 */
function h5StatusOf(code: string): number {
  switch (code) {
    case 'unknown-ticket':
      return 404
    case 'foreign-ticket':
      return 403
    case 'already-decided':
    case 'expired':
      return 409
    default:
      return 400
  }
}

/** H5 错误文案（与文本指令同口径）。 */
function h5TextOf(code: string, fallback: string): string {
  switch (code) {
    case 'unknown-ticket':
      return UNKNOWN_TICKET_TEXT
    case 'foreign-ticket':
      return FOREIGN_TICKET_TEXT
    case 'invalid-decision':
      return INVALID_DECISION_TEXT
    case 'reason-required':
      return REASON_REQUIRED_TEXT
    case 'already-decided':
      return ALREADY_DECIDED_TEXT
    case 'expired':
      return EXPIRED_TEXT
    case 'no-challenge':
      return NO_CHALLENGE_TEXT
    default:
      return fallback.length > 0 ? fallback : VERIFY_FAILED_TEXT
  }
}

/** 请求体字段读取（只认 decision / reason）。 */
type SubmitBody =
  | { readonly ok: true; readonly decision: 'allowed-once' | 'rejected'; readonly reason?: string }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** 解析提交体（拒绝理由必填，≤500 字）。 */
function parseSubmitBody(raw: string): SubmitBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'im-h5-invalid-body', reason: '请求体必须是 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'im-h5-invalid-body', reason: '请求体必须是 JSON 对象' }
  }
  const record = parsed as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => key !== 'decision' && key !== 'reason')
  if (unknown !== undefined) {
    return { ok: false, code: 'im-h5-invalid-body', reason: `未知字段：${unknown}` }
  }
  const decision = record['decision']
  if (decision !== 'allowed-once' && decision !== 'rejected') {
    return { ok: false, code: 'invalid-decision', reason: INVALID_DECISION_TEXT }
  }
  const rawReason = record['reason']
  const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
  if (decision === 'rejected') {
    if (reason.length === 0) return { ok: false, code: 'reason-required', reason: REASON_REQUIRED_TEXT }
    if (reason.length > IM_COMMAND_MAX_REASON) {
      return { ok: false, code: 'reason-required', reason: `拒绝理由不得超过 ${String(IM_COMMAND_MAX_REASON)} 字` }
    }
  }
  return {
    ok: true,
    decision,
    ...(reason.length === 0 ? {} : { reason }),
  }
}

/**
 * `POST /a/:token`（decision）或 `POST /a/:token/verify`。
 */
export async function handleApproveSubmit(
  token: string,
  rawBody: string,
  res: ServerResponse,
  deps: ApprovalPageDeps,
  kind: 'decision' | 'verify',
): Promise<void> {
  const now = deps.nowMs?.() ?? Date.now()
  const verdict = verifyApprovalLink(token, deps.config.linkSecret, now)
  if (!verdict.ok) {
    deps.log.warn('im-h5-token-rejected', { code: verdict.code, tokenHash8: tokenDigest(token) })
    writeJson(res, verdict.code === 'expired' ? 410 : 403, errorBody(`im-h5-${verdict.code}`, '链接无效或已过期'))
    return
  }

  const record = deps.supervisor.get(verdict.payload.s)
  if (record === undefined || record.status !== 'ready' || record.client === undefined) {
    writeJson(res, 503, errorBody('im-h5-unavailable', '票据已处理或状态未知'))
    return
  }

  if (kind === 'verify') {
    const result = await record.client.verify(verdict.payload.t)
    if (result.status === 200) {
      deps.hub.markVerified(verdict.payload.s, verdict.payload.t)
      deps.log.info('im-h5-submit', { ticketId: verdict.payload.t, decision: 'verify' })
      writeJson(res, 200, { ok: true })
      return
    }
    const error = childErrorOf(result)
    deps.log.info('im-h5-submit', {
      ticketId: verdict.payload.t,
      decision: 'verify',
      code: error.code,
    })
    writeJson(res, h5StatusOf(error.code), errorBody(error.code, h5TextOf(error.code, error.reason)))
    return
  }

  const body = parseSubmitBody(rawBody)
  if (!body.ok) {
    writeJson(res, 400, errorBody(body.code, body.reason))
    return
  }

  // 红级防误触（与文本 `1` 同口径）：已知未验证的红级票据不转发，也不消费链接
  const ticket = deps.hub.pendingGet(verdict.payload.s, verdict.payload.t)
  if (
    body.decision === 'allowed-once' &&
    ticket !== undefined &&
    (ticket.tier === 'red' || ticket.challenge !== undefined) &&
    !ticket.verified
  ) {
    writeJson(res, 400, errorBody('challenge-required', '该票据需要强验证，请先完成验证'))
    return
  }

  // 一次性在"真正会转发"的合法提交上消费：解析错误 / 红级拦截都不烧链接
  if (!deps.usedLinks.claim(token)) {
    deps.log.warn('im-h5-token-rejected', { code: 'replayed', tokenHash8: tokenDigest(token) })
    writeJson(res, 409, errorBody('im-h5-used', '该链接已提交过'))
    return
  }

  const result = await record.client.decide(verdict.payload.t, {
    decision: body.decision,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
  })
  // 只记录理由长度：拒绝理由原文已在子进程审计里（G11）
  deps.log.info('im-h5-submit', {
    ticketId: verdict.payload.t,
    decision: body.decision,
    ...(body.reason === undefined ? {} : { reasonLength: body.reason.length }),
  })
  if (result.status === 200) {
    writeJson(res, 200, { ok: true })
    return
  }
  const error = childErrorOf(result)
  writeJson(res, h5StatusOf(error.code), errorBody(error.code, h5TextOf(error.code, error.reason)))
}

/**
 * 静态资源（`approve.css` / `approve.js`）。
 *
 * @returns `false` = 不是本模块的资源
 */
export function handleApprovalAsset(name: string, res: ServerResponse): boolean {
  const content = name === 'approve.css' ? CSS : name === 'approve.js' ? JS : undefined
  if (content === undefined) return false
  const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
  res.writeHead(200, {
    ...H5_SECURITY_HEADERS,
    'content-type': type,
    'content-length': Buffer.byteLength(content),
  })
  res.end(content)
  return true
}
