/**
 * 交易密码（**不是**登录密码）的口径常量和纯校验函数（ADR-0014）。
 *
 * ## 为什么单独一个文件
 *
 * 三条纪律要能被单测逐条钉住，且不依赖任何账本状态：
 * 1. **长度 8–20**、**同时含字母与数字**、**新 ≠ 旧**——校验顺序固定（先便宜后贵）；
 * 2. 失败文案**不得泄露"哪一位错了"**：只有"不符合要求"与"旧密码不正确"两种说法；
 * 3. 连续失败 3 次锁定，锁定窗口过后重新计数。
 *
 * ## 明文去哪了
 *
 * **本仓任何持久面都不存明文**：
 * - 工具入参里**没有**密码字段（`password_change` 的 schema 只有 `action`）；
 * - 会话日志（`sessions/<sessionId>/session.jsonl`）只落 `security/password-changed` 的
 *   `{ userId, method, at }`，载荷里没有明文/哈希/盐；
 * - 明文只在 HTTP handler 的栈帧里存在一次，交给 `MockBankCore` 后立刻变成
 *   `sha256(salt + password)`，且该 Map 与盐都**只在内存**，进程退出即消失。
 *
 * 这也是本设计选择"交办"而不是"代改"的原因：模型不接触密码，日志就不可能沾上。
 */

import { BahError, sha256Hex } from '@bah/util'

/** 新密码最短长度。 */
export const TXN_PASSWORD_MIN_LENGTH = 8
/** 新密码最长长度。 */
export const TXN_PASSWORD_MAX_LENGTH = 20
/** 连续失败多少次后锁定。 */
export const TXN_PASSWORD_MAX_ATTEMPTS = 3
/** 锁定时长（毫秒）。窗口过后失败计数归零、可再次尝试。 */
export const TXN_PASSWORD_LOCK_MS = 15 * 60_000
/**
 * 演示用初始交易密码（demo 口令，**不是秘密**）。
 *
 * 写进 `docs/adr/0014-password-change-handoff.md` 的"已知风险"一节：任何拿到 demo 会话的人都能用它走通改密流程——演示仓如此，
 * 真实部署由 `credentials` 面注入，不由本仓给默认口令。
 */
export const DEMO_TXN_PASSWORD = 'bank1234'
/** 安全页路径（明文只在这一页的表单里提交）。 */
export const PASSWORD_HANDOFF_PATH = '/secure/password'
/** 交办票据 TTL（秒）。 */
export const PASSWORD_HANDOFF_TTL_SECONDS = 120

/** 盐的派生口径（进程内、按用户不同；**不是**密码学意义上的随机盐，见文件头）。 */
const SALT_NAMESPACE = 'bah-txn-password-salt/1'

/**
 * 派生某用户的盐（16 hex，进程内确定）。
 *
 * 为什么不用 `Math.random()`：盐**从不离开进程**、也不参与任何输出，它的唯一作用是让
 * "同口令不同用户"得到不同哈希；用确定性派生换来的是单测与回放不依赖熵。
 * 真实实现必须换成 CSPRNG + 持久化盐（ADR-0014 §3 已登记为"不声称"）。
 */
export function deriveTxnPasswordSalt(userId: string): string {
  return sha256Hex(`${SALT_NAMESPACE}|${userId}`).slice(0, 16)
}

/** 口令摘要（`sha256(salt + password)`，hex）。 */
export function hashTxnPassword(salt: string, password: string): string {
  return sha256Hex(`${salt}:${password}`)
}

/**
 * 新密码的格式校验（长度 → 字符类别 → 与旧密码不同）；任一不满足抛 `password-invalid`。
 *
 * **先便宜后贵**：这三步都不需要读账本，放在"旧密码比对"之前，错口令猜测就不会
 * 顺带消耗"旧密码比对"这条更贵的路径（也是失败计数的分界：格式错**不计数**，
 * 否则用户打错一次格式就把自己逼近锁定）。
 *
 * @throws `BahError('password-invalid')`（文案只描述规则，不指认哪一位）
 */
export function assertNewTxnPassword(newPassword: unknown, oldPassword: string): void {
  if (typeof newPassword !== 'string') {
    throw new BahError('password-invalid', `新交易密码必须是字符串`, { kind: 'type' })
  }
  if (
    newPassword.length < TXN_PASSWORD_MIN_LENGTH ||
    newPassword.length > TXN_PASSWORD_MAX_LENGTH
  ) {
    throw new BahError(
      'password-invalid',
      `新交易密码长度必须在 ${String(TXN_PASSWORD_MIN_LENGTH)}–${String(TXN_PASSWORD_MAX_LENGTH)} 位之间`,
      { kind: 'length' },
    )
  }
  if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    throw new BahError('password-invalid', '新交易密码必须同时包含字母与数字', { kind: 'charset' })
  }
  if (newPassword === oldPassword) {
    throw new BahError('password-invalid', '新交易密码不能与旧密码相同', { kind: 'same' })
  }
}

/** 剩余可尝试次数（`locked` 时为 0）。 */
export function remainingPasswordAttempts(failures: number, locked: boolean): number {
  if (locked) return 0
  return Math.max(0, TXN_PASSWORD_MAX_ATTEMPTS - failures)
}
