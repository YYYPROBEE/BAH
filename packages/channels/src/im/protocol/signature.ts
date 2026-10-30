/**
 * 微信回调验签（施工单 02 §2.5）。
 *
 * WHY 常量时间比较：`signature === expected` 会把"前缀匹配了多少字节"变成计时侧信道，
 * 攻击者据此可以逐字节还原正确签名——验签是公网第一个入口，这条不能省。
 *
 * 三条口径（§2.5 原文）：
 * - `sha1([token, timestamp, nonce].sort().join(''))` 十六进制；
 * - `|nowSec - timestamp| ≤ 600`（重放窗口 10 分钟）；
 * - token / signature / timestamp / nonce 任一为空即 `missing`（与"签名错"区分开：
 *   前者是配置或调用方漏参，后者是攻击）。
 *
 * `nowSec` 由调用方注入：验签是纯函数，时钟只在边界处读一次（测试可控）。
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** 重放窗口（秒）：微信重试最长几分钟，600 秒足够且不给"隔夜重放"留口子。 */
export const WECHAT_SIGNATURE_WINDOW_SEC = 600

/** nonce 允许的长度区间（微信给的是随机串；过长视为异常输入）。 */
const NONCE_MIN_LENGTH = 1
const NONCE_MAX_LENGTH = 128

/** 验签输入。 */
export interface WechatSignatureInput {
  /** 公众号后台自填的 token（只从环境变量来，不落文档/夹具）。 */
  readonly token: string
  /** 微信下发的 `signature` 查询参数。 */
  readonly signature: string
  /** 微信下发的 `timestamp` 查询参数（10 位秒级整数）。 */
  readonly timestamp: string
  /** 微信下发的 `nonce` 查询参数。 */
  readonly nonce: string
  /** 当前时刻（epoch 秒，由调用方注入）。 */
  readonly nowSec: number
}

/** 验签结论（细分失败原因只为日志，**不回显**给调用方）。 */
export type SignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'missing' | 'stale' | 'nonce' | 'mismatch' }

/** 计算签名（纯函数；测试与运维排障共用）。 */
export function computeWechatSignature(token: string, timestamp: string, nonce: string): string {
  return createHash('sha1')
    .update([token, timestamp, nonce].sort().join(''))
    .digest('hex')
}

/** 十位秒级整数的形态（微信的 `timestamp` 只有这一种合法形状）。 */
const TIMESTAMP_PATTERN = /^\d{10}$/

/**
 * 验签。
 *
 * @param input 见 {@link WechatSignatureInput}
 */
export function verifyWechatSignature(input: WechatSignatureInput): SignatureVerdict {
  if (
    input.token.length === 0 ||
    input.signature.length === 0 ||
    input.timestamp.length === 0 ||
    input.nonce.length === 0
  ) {
    return { ok: false, code: 'missing' }
  }

  if (!TIMESTAMP_PATTERN.test(input.timestamp)) return { ok: false, code: 'stale' }
  const timestamp = Number(input.timestamp)
  if (Math.abs(input.nowSec - timestamp) > WECHAT_SIGNATURE_WINDOW_SEC) {
    return { ok: false, code: 'stale' }
  }

  if (input.nonce.length < NONCE_MIN_LENGTH || input.nonce.length > NONCE_MAX_LENGTH) {
    return { ok: false, code: 'nonce' }
  }

  const expected = computeWechatSignature(input.token, input.timestamp, input.nonce)
  const presented = input.signature.toLowerCase()
  // 长度不等先短路：`timingSafeEqual` 对不等长 Buffer 直接抛，不能让它抛到调用方。
  if (presented.length !== expected.length) return { ok: false, code: 'mismatch' }
  return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'))
    ? { ok: true }
    : { ok: false, code: 'mismatch' }
}
