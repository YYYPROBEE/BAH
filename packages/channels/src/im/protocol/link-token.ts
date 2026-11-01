/**
 * H5 审批链接的签名与校验。
 *
 * 形态：`base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(secret, base64urlPart))`。
 *
 * 三条纪律：
 * 1. **签名比较必须常量时间**（`timingSafeEqual`）；长度不等也先做一次同长比较再返回，
 *    不让提前 `return` 成为计时侧信道。
 * 2. **过期即拒绝**：`e` 是 epoch ms，`nowMs >= e` 一律 `expired`，绝不默认放行。
 * 3. **只认版本 1**：未知版本返回 `unsupported`，不尝试兼容——链接是凭证，兼容旧格式等于
 *    给未来的降级攻击留门。
 *
 * 本文件是纯函数：无时钟、无 I/O、无全局状态（时钟由调用方注入）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { BahError } from '@bah/util'

import { IM_SESSION_ID_PATTERN } from '../session.ts'

/** 当前链接版本（唯一合法值）。 */
export const APPROVAL_LINK_VERSION = 1

/** 链接 TTL 上限（5 分钟；票据自身 TTL 更短时取票据的）。 */
export const APPROVAL_LINK_MAX_TTL_MS = 5 * 60 * 1000

/** 密钥最小长度（与 `BAH_IM_LINK_SECRET` 同口径）。 */
export const APPROVAL_LINK_SECRET_MIN = 32

/** 链接首段（JSON）的最大长度（防超长输入打爆解析）。 */
const MAX_PAYLOAD_PART_LENGTH = 768

/** 链接整体最大长度。 */
const MAX_TOKEN_LENGTH = 1024

/** 票据 ID 的形态（与宿主 `TICKET_PATTERN` 同口径；网关转发前也校验）。 */
const TICKET_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/** 链接载荷（进 token 的明文；不含任何用户标识）。 */
export interface ApprovalLinkPayload {
  readonly v: 1
  /** 会话键（`im-xxxxxxxxxxxxxxxx`）。 */
  readonly s: string
  /** 票据 ID。 */
  readonly t: string
  /** 过期时刻（epoch ms）。 */
  readonly e: number
}

/** 校验结论。 */
export type ApprovalLinkVerdict =
  | { readonly ok: true; readonly payload: ApprovalLinkPayload }
  | { readonly ok: false; readonly code: 'malformed' | 'bad-signature' | 'expired' | 'unsupported' }

/** 签名（HMAC-SHA256 → base64url）。 */
function signatureOf(secret: string, part: string): Buffer {
  return createHmac('sha256', secret).update(part).digest()
}

/** 校验密钥长度（签名前 fail-loud，不签一个弱密钥的链接）。 */
function assertSecret(secret: string): void {
  if (secret.length < APPROVAL_LINK_SECRET_MIN) {
    throw new BahError(
      'im-link-secret-weak',
      `im: 链接密钥至少 ${String(APPROVAL_LINK_SECRET_MIN)} 字符`,
    )
  }
}

/**
 * 签一条审批链接（调用方负责把 `e` 取到 `min(票据 TTL, now+5min)`）。
 *
 * @throws `BahError('im-link-secret-weak')` 密钥不足 32 字符
 * @throws `BahError('im-link-payload-invalid')` 载荷字段非法
 */
export function signApprovalLink(payload: ApprovalLinkPayload, secret: string): string {
  assertSecret(secret)
  if (!Number.isSafeInteger(payload.e) || payload.e <= 0) {
    throw new BahError('im-link-payload-invalid', 'im: 链接过期时刻必须是正整数（epoch ms）')
  }
  if (!IM_SESSION_ID_PATTERN.test(payload.s)) {
    throw new BahError('im-link-payload-invalid', 'im: 链接载荷的会话键形态非法', {
      sessionKey: payload.s,
    })
  }
  if (!TICKET_PATTERN.test(payload.t)) {
    throw new BahError('im-link-payload-invalid', 'im: 链接载荷的票据 ID 形态非法')
  }
  const part = Buffer.from(
    JSON.stringify({ v: payload.v, s: payload.s, t: payload.t, e: payload.e }),
    'utf8',
  ).toString('base64url')
  const signature = signatureOf(secret, part).toString('base64url')
  return `${part}.${signature}`
}

/** 解析首段 JSON 并校验字段形态（不校验签名）。 */
function parsePayload(
  part: string,
): { readonly ok: true; readonly payload: ApprovalLinkPayload } | { readonly ok: false; readonly code: 'malformed' | 'unsupported' } {
  if (part.length === 0 || part.length > MAX_PAYLOAD_PART_LENGTH) return { ok: false, code: 'malformed' }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown
  } catch {
    return { ok: false, code: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, code: 'malformed' }
  const record = parsed as Record<string, unknown>
  const v = record['v']
  if (v !== APPROVAL_LINK_VERSION) return { ok: false, code: 'unsupported' }
  const s = record['s']
  const t = record['t']
  const e = record['e']
  if (typeof s !== 'string' || !IM_SESSION_ID_PATTERN.test(s)) return { ok: false, code: 'malformed' }
  if (typeof t !== 'string' || !TICKET_PATTERN.test(t)) return { ok: false, code: 'malformed' }
  if (typeof e !== 'number' || !Number.isSafeInteger(e) || e <= 0) return { ok: false, code: 'malformed' }
  return { ok: true, payload: { v: APPROVAL_LINK_VERSION, s, t, e } }
}

/**
 * 校验一条审批链接。
 *
 * @param token `signApprovalLink` 的产物
 * @param secret 同一密钥
 * @param nowMs 当前时刻（epoch ms，注入）
 */
export function verifyApprovalLink(
  token: string,
  secret: string,
  nowMs: number,
): ApprovalLinkVerdict {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, code: 'malformed' }
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.') || dot === token.length - 1) {
    return { ok: false, code: 'malformed' }
  }
  const part = token.slice(0, dot)
  const signaturePart = token.slice(dot + 1)
  if (part.length === 0 || signaturePart.length === 0) return { ok: false, code: 'malformed' }

  // 签名先于 JSON：没验签的载荷不进入任何字段判定（不让畸形 JSON 成为探测面）
  const expected = signatureOf(secret, part)
  const presented = Buffer.from(signaturePart, 'base64url')
  if (presented.length !== expected.length) {
    // 长度不等也做一次同长比较：调用点不因提前返回而出现可测的时间差
    timingSafeEqual(Buffer.alloc(expected.length), Buffer.alloc(expected.length))
    return { ok: false, code: 'bad-signature' }
  }
  if (!timingSafeEqual(presented, expected)) return { ok: false, code: 'bad-signature' }

  const parsed = parsePayload(part)
  if (!parsed.ok) return parsed
  if (nowMs >= parsed.payload.e) return { ok: false, code: 'expired' }
  return { ok: true, payload: parsed.payload }
}
