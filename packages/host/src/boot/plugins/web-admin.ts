/**
 * Web 管理路由的**纯函数**部分（施工单 HP-0 §3.2）。
 *
 * 这里只做四件事：读 token、判回环、比 token、解 body。
 * 路由编排（状态码、`sendJson`）留在 `web.ts`——纯函数好测，编排难测。
 *
 * ## 三条设计约束（都是硬约束，不是偏好）
 *
 * 1. **默认关闭**：没设 `BAH_ADMIN_TOKEN` 就 404，不暴露路由存在性；
 * 2. **只绑本机**：非回环来源一律 403，且不加 CORS——管理面只服务本机 CLI；
 * 3. **token 只从环境变量读**：不进 URL、不进 argv、不进审计、不进日志。
 */

import { timingSafeEqual } from 'node:crypto'

/** 管理 token 的环境变量名（只此一处）。 */
export const ADMIN_TOKEN_ENV = 'BAH_ADMIN_TOKEN'

/** `by` 字段上限（字符）。 */
const MAX_BY = 64

/** `reason` 字段上限（字符）。 */
const MAX_REASON = 200

/** 缺省理由（请求没写 reason 时用它，审计里可读）。 */
export const DEFAULT_UNFREEZE_REASON = 'operator-unfreeze'

/** body 解析结果。 */
export type UnfreezeBody =
  | { readonly ok: true; readonly by: string; readonly reason: string }
  | { readonly ok: false; readonly code: 'web-admin-invalid-body'; readonly detail: string }

/**
 * 读管理 token。
 *
 * @returns 非空则返回；未设置或全空白返回 `undefined`（调用方据此返回 404）
 */
export function readAdminToken(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = env[ADMIN_TOKEN_ENV]
  if (raw === undefined) return undefined
  const token = raw.trim()
  return token === '' ? undefined : token
}

/**
 * 是否回环地址。
 *
 * 只认 IPv4 回环段、IPv6 回环、以及 IPv4-mapped 的回环写法。
 * **不接受** `0.0.0.0`、`::`（那是"监听全部"，不是"来自本机"）。
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address === '') return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (normalized === '::1') return true
  const parts = normalized.split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== '127') return false
  // 每段都必须是 0–255 的十进制整数（挡掉 `127.0.0.999` / 十六进制写法）
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 比 token（定长比较，先判长度）。
 *
 * 长度不同直接 false：`timingSafeEqual` 在长度不等时会抛错，
 * 捕获它再返回 false 会把"长度不同"变成异常路径，反而更容易被计时区分。
 */
export function tokenMatches(expected: string, authorization: string | undefined): boolean {
  if (authorization === undefined) return false
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  const presented = match?.[1]?.trim()
  if (presented === undefined || presented === '') return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(presented, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 解析解冻请求体。
 *
 * 严格拒绝未知键：管理面不接受"多余字段"，否则以后加字段时无法判断旧客户端意图。
 */
export function parseUnfreezeBody(body: unknown): UnfreezeBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'web-admin-invalid-body', detail: '请求体必须是 JSON 对象' }
  }
  const record = body as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'by' && key !== 'reason') {
      return { ok: false, code: 'web-admin-invalid-body', detail: `未知字段：${key}` }
    }
  }

  const by = record['by']
  if (typeof by !== 'string' || by.trim() === '') {
    return { ok: false, code: 'web-admin-invalid-body', detail: 'by 必填且非空' }
  }
  if ([...by].length > MAX_BY) {
    return { ok: false, code: 'web-admin-invalid-body', detail: `by 不得超过 ${String(MAX_BY)} 字符` }
  }

  const reason = record['reason']
  if (reason !== undefined) {
    if (typeof reason !== 'string') {
      return { ok: false, code: 'web-admin-invalid-body', detail: 'reason 必须是字符串' }
    }
    if ([...reason].length > MAX_REASON) {
      return {
        ok: false,
        code: 'web-admin-invalid-body',
        detail: `reason 不得超过 ${String(MAX_REASON)} 字符`,
      }
    }
  }

  const trimmedReason = typeof reason === 'string' ? reason.trim() : ''
  return {
    ok: true,
    by: by.trim(),
    reason: trimmedReason === '' ? DEFAULT_UNFREEZE_REASON : trimmedReason,
  }
}
