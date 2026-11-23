/**
 * 授权窗口的**跨重启签名回执**（F-01 / ADR-0010 阶段 B）。
 *
 * ## 它解决什么问题
 *
 * 武装时的那次强验证（人脸 / 短信 / U 盾）结论存在银行侧 `VerifyService` 的
 * **进程内 Map** 里（`bank/src/verify/index.ts`）。进程一重启，`passed(challengeId)`
 * 就是 `false`——计划"到期必成功"的承诺随之失效。
 *
 * 回执把"这次验证发生在哪个窗口、哪个节点、什么时候、什么时候过期"用部署密钥
 * 做一次 HMAC，写进 `ArmedPlan.challenge.receipt`。`ArmedPlan` 本身随
 * `plan_arm` 的 `tool/result` 落进会话日志，重启后 `replayArmedPlans` 原样读回；
 * 于是**验证结论**也能跨进程成立，而不再依赖内存。
 *
 * ## 为什么是 HMAC 而不是新造一套密钥体系
 *
 * 单租户宿主既是签发方也是核验方，HMAC 足够；密钥来自部署环境
 * （`BAH_WINDOW_RECEIPT_KEY`，≥32 字节随机串），**不进仓**。
 * 没有密钥时回执缺省不签发，行为退回阶段 A（同进程挑战结论），
 * 并在启动期留一条告警——不会静默假装"跨重启已支持"。
 *
 * ## 边界（别把它讲大）
 *
 * - 回执按 `(windowId, planId, nodeId)` 绑定：同一窗口的另一条腿不能复用；
 * - 它证明的是"武装时确实验过人且这些字段没被改过"，不证明"这次唤醒的世界仍然合适"
 *   ——世界快照 / 预算 / 档位仍由 `WindowSigner` 每次重算；
 * - 同一节点在 `resume` 里的重试可以复用同一张回执（attempt 变化不影响），
 *   这是有意为之：验证的是"人"，不是"第几次尝试"。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { canonicalJson } from '@bah/util'

/** 回执覆盖的字段（顺序由 `canonicalJson` 归一，不依赖对象字面量顺序）。 */
export interface WindowReceiptPayload {
  readonly sessionId: string
  readonly windowId: string
  readonly planId: string
  /** 窗口内全部节点 id（排序后写入，避免声明顺序造成假不一致）。 */
  readonly nodeIds: readonly string[]
  readonly challengeId: string
  readonly channel: 'face' | 'sms' | 'ushield'
  readonly verifiedAt: number
  readonly expiresAt: number
}

/** 回执密钥的最小长度（字节；低于它直接视为"未配置"，不签弱密钥）。 */
export const WINDOW_RECEIPT_KEY_MIN_BYTES = 32

/**
 * 解析部署密钥。
 *
 * @returns 合法密钥；空 / 过短 / 非字符串一律 `undefined`（调用方据此关闭回执）
 */
export function resolveWindowReceiptKey(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (value === undefined || value.length === 0) return undefined
  if (Buffer.byteLength(value, 'utf8') < WINDOW_RECEIPT_KEY_MIN_BYTES) return undefined
  return value
}

/** 生成回执（base64url；确定性：同一 payload + 同一密钥结果逐字节相同）。 */
export function createWindowReceipt(key: string, payload: WindowReceiptPayload): string {
  return createHmac('sha256', key).update(canonicalJson(payload), 'utf8').digest('base64url')
}

/**
 * 验签。
 *
 * 任何异常（密钥形状、编码）都返回 `false`——验不过就是验不过，不把异常
 * 翻译成"放行"，也不把具体原因回给调用方（避免给攻击者信息）。
 */
export function verifyWindowReceipt(
  key: string,
  payload: WindowReceiptPayload,
  receipt: string,
): boolean {
  try {
    const expected = Buffer.from(createWindowReceipt(key, payload), 'utf8')
    const actual = Buffer.from(receipt, 'utf8')
    if (expected.length !== actual.length) return false
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}
