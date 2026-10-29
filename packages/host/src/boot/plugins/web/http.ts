/**
 * `channel:web` 的 HTTP 原语（W16 从 `web.ts` 拆出）。
 *
 * 这里只放**与路由无关**的东西：响应信封、安全头、请求体读取。
 * 一条纪律：任何"调用方写错了"的错误都必须映射成 4xx（`REQUEST_ERROR_STATUS`），
 * 用 500 会让前端把用户的输入问题报成"服务器故障"，也会把真正的内部错误淹没掉。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { describeThrown } from '@bah/core'
import { BahError } from '@bah/util'

/** 所有响应都带的浏览器安全头（CSP 只允许同源脚本/样式/连接）。 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
}

/** 请求体上限（64 KiB）：对话输入不该是上传通道。 */
export const MAX_BODY_BYTES = 64 * 1024

/** 票据 ID 白名单（会进日志与查询键，禁止任意字符）。 */
export const TICKET_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * 请求处理期抛出的**客户端**错误 → HTTP 状态码。
 *
 * 未登记的一律 500：这些码是"调用方写错了"，用 500 会让前端把用户的输入问题
 * 报成"服务器故障"，也会把真正的内部错误淹没在同一种响应里。
 */
export const REQUEST_ERROR_STATUS: Readonly<Record<string, number>> = {
  'web-body-too-large': 413,
  'web-invalid-body': 400,
  'web-invalid-json': 400,
  // HALT 期间的新 turn 不是"服务器错误"：423 Locked 让客户端知道"系统被停机"
  'safety-halted': 423,
  // 认证会话达到上限：503 让客户端知道"现在签不出新会话"，不是内部错误
  'web-auth-capacity': 503,
}

/** 发一个 JSON 响应。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 结构化错误响应。 */
export function sendError(res: ServerResponse, status: number, code: string, reason: string): void {
  sendJson(res, status, { error: { code, reason } })
}

/** 读请求体（JSON；空体视为 `{}`）。 */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new BahError('web-body-too-large', `web: 请求体超过 ${String(MAX_BODY_BYTES)} 字节`)
    }
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BahError('web-invalid-body', 'web: 请求体必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof BahError) throw error
    throw new BahError('web-invalid-json', 'web: 请求体不是合法 JSON')
  }
}

/** 读字符串字段。 */
export function readBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 读 cookie（只取第一个同名项；缺失返回 `undefined`）。
 *
 * 不用第三方 cookie 解析器：只有一条自签 cookie，自己按 `;` 切比多一个依赖更可控。
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim()
  }
  return undefined
}

/** 请求处理的兜底：单个请求出错不能拖垮服务，也不许静默。 */
export function sendThrown(res: ServerResponse, error: unknown): void {
  const code = error instanceof BahError ? error.code : 'web-internal'
  if (!res.headersSent) {
    sendError(res, REQUEST_ERROR_STATUS[code] ?? 500, code, describeThrown(error))
  } else {
    res.end()
  }
}
