/**
 * IM 会话键派生。
 *
 * WHY 不直接用 openid 当会话 ID：
 * 1. openid 是平台用户标识，落日志/落路径就是一条可关联的 PII（I-IM-05 禁止）；
 * 2. 会话 ID 要能进目录名与文件名（`<persistence.root>/<tenant>/<sessionId>/`），
 *    openid 的字符集不受本工程控制；
 * 3. 同一用户在 `wechat` 与 `mock` 上必须是两个会话（平台命名空间隔离，T-CH-007）。
 *
 * 派生 = `im-` + HMAC-SHA256(`${platform}\0${userId}`, salt) 前 16 hex。
 * 稳定性：同一 `(platform,userId)` + 同一 salt 重启后仍得到同一 ID ⇒ 会话日志可回放。
 */

import { createHmac } from 'node:crypto'

import { BahError } from '@bah/util'

/** 合法 IM 会话 ID 的形态（16 hex 足够抗碰撞、又比完整 digest 短）。 */
export const IM_SESSION_ID_PATTERN = /^im-[0-9a-f]{16}$/

/** salt 的最小长度（短 salt 等于没加盐）。 */
const MIN_SALT_LENGTH = 16

/**
 * 由平台与平台用户标识派生稳定会话 ID。
 *
 * @throws `BahError('im-empty-platform')` platform 空白
 * @throws `BahError('im-empty-user')` userId 空白
 * @throws `BahError('im-weak-session-salt')` salt 不足 16 字符
 */
export function deriveImSessionId(platform: string, userId: string, salt: string): string {
  if (platform.trim().length === 0) {
    throw new BahError('im-empty-platform', 'im: platform 不能为空（会话键的命名空间前缀）')
  }
  if (userId.trim().length === 0) {
    throw new BahError('im-empty-user', 'im: userId 不能为空（派生会话键的唯一输入）')
  }
  if (salt.length < MIN_SALT_LENGTH) {
    throw new BahError('im-weak-session-salt', `im: salt 必须至少 ${String(MIN_SALT_LENGTH)} 字符（短盐等于没加盐）`)
  }
  const digest = createHmac('sha256', salt)
    // 分隔符用 NUL：`platform='ab', userId='c'` 与 `platform='a', userId='bc'` 不能撞同一输入
    .update(`${platform}\u0000${userId}`.trim())
    .digest('hex')
    .slice(0, 16)
  const id = `im-${digest}`
  // 派生结果必须过形态校验：拼接/截断一旦被后人改动，这里立刻抛而不是放行到目录名
  return assertImSessionId(id)
}

/**
 * 校验一个字符串是否是合法 IM 会话 ID。
 *
 * @throws `BahError('im-invalid-session-id')` 形态不合法
 */
export function assertImSessionId(value: string): string {
  if (!IM_SESSION_ID_PATTERN.test(value)) {
    throw new BahError('im-invalid-session-id', `im: 非法会话 ID '${value}'（期望 ${IM_SESSION_ID_PATTERN.source}）`, {
      value,
    })
  }
  return value
}
