/**
 * @bah/persistence · credentials（施工单 09 §4 的身份绑定渠道）。
 *
 * 三个渠道统一走**同一个**服务键 `CREDENTIALS`：
 * - `mock-login`：手机号 + mock 短信验证码（演示 / 回归；真实验证码由短信下发，这里回给调用方）；
 * - `im-map`：IM 用户 ID ↔ 银行 userId 映射表（飞书 / 微信，施工单 15 接线）；
 * - `demo-config`：profile 显式写 `demoUserId`（headless 排练用，由 `bank:tools` 直接绑定）。
 *
 * 纪律：
 * 1. **无隐式默认账户**：登录失败不绑定、不回落；
 * 2. 绑定本身是**会话级 durable 事实**：本模块只产出「谁（userId）以什么方式（method）绑定」，
 *    落账 `identity/bound` 由宿主注入的 `SessionIdentityBinding` 完成（回放可恢复）；
 * 3. 时间与随机全量注入——验证码有效期、确定性码值都由调用方给。
 */

import { defineService } from '@bah/core'
import { BahError } from '@bah/util'

import type { ServiceKey, SessionId } from '@bah/core'

/** 绑定方式（与 `@bah/bank` 的 `IdentityMethod` 同值集；本包不依赖 bank）。 */
export type IdentityBindingMethod = 'demo-config' | 'mock-login' | 'im-map'

/** 登录用户目录的一行（手机号必须唯一）。 */
export interface SmsDirectoryUser {
  readonly userId: string
  readonly phone: string
}

/** 一次 mock 短信登录挑战。 */
export interface SmsLoginChallenge {
  /** 登录会话 ID（验证时回传）。 */
  readonly loginId: string
  readonly phone: string
  /** 验证码（**仅 mock**：真实渠道由短信下发，不回给调用方）。 */
  readonly code: string
  /** 过期时刻（epoch ms）。 */
  readonly expiresAt: number
}

/** 挑战签发结果。 */
export type SmsChallengeResult =
  | { readonly ok: true; readonly challenge: SmsLoginChallenge }
  | { readonly ok: false; readonly code: 'phone-unknown' }

/** 登录结论。 */
export type SmsLoginResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly code: SmsLoginFailure }

/** 登录失败理由码。 */
export type SmsLoginFailure = 'login-unknown' | 'code-mismatch' | 'code-expired'

/** `MockSmsLoginService` 的装配参数。 */
export interface MockSmsLoginOptions {
  readonly users: readonly SmsDirectoryUser[]
  /** 时钟（确定性注入）。 */
  readonly now: () => number
  /** 验证码有效期（ms；缺省 5 分钟）。 */
  readonly codeTtlMs?: number
  /** 随机源（0–1；缺省 `Math.random`；测试注入 `seededRandom`）。 */
  readonly random?: () => number
}

/** 默认验证码有效期（5 分钟）。 */
export const DEFAULT_CODE_TTL_MS = 5 * 60 * 1000

/**
 * mock 短信登录（两段式：申请 → 校验）。
 *
 * 验证码一次性：校验成功即作废（重复校验返回 `login-unknown`）。
 */
export class MockSmsLoginService {
  private readonly usersByPhone = new Map<string, string>()
  private readonly challenges = new Map<
    string,
    { readonly phone: string; readonly code: string; readonly userId: string; readonly expiresAt: number }
  >()
  private readonly now: () => number
  private readonly codeTtlMs: number
  private readonly random: () => number
  private sequence = 0

  constructor(options: MockSmsLoginOptions) {
    for (const user of options.users) {
      this.usersByPhone.set(user.phone, user.userId)
    }
    this.now = options.now
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS
    this.random = options.random ?? Math.random
  }

  /**
   * 申请验证码。
   *
   * @returns 未知手机号返回 `phone-unknown`（不泄露"该号是否存在"以外的信息）
   */
  request(phone: string): SmsChallengeResult {
    const normalized = phone.trim()
    const userId = this.usersByPhone.get(normalized)
    if (userId === undefined) return { ok: false, code: 'phone-unknown' }
    this.sequence += 1
    const challenge: SmsLoginChallenge = {
      loginId: `login-${this.sequence}`,
      phone: normalized,
      code: this.mintCode(),
      expiresAt: this.now() + this.codeTtlMs,
    }
    this.challenges.set(challenge.loginId, {
      phone: challenge.phone,
      code: challenge.code,
      userId,
      expiresAt: challenge.expiresAt,
    })
    return { ok: true, challenge }
  }

  /**
   * 校验验证码。
   *
   * @returns 成功时返回 `userId` 并作废该挑战
   */
  verify(loginId: string, code: string): SmsLoginResult {
    const challenge = this.challenges.get(loginId)
    if (challenge === undefined) return { ok: false, code: 'login-unknown' }
    if (this.now() >= challenge.expiresAt) {
      this.challenges.delete(loginId)
      return { ok: false, code: 'code-expired' }
    }
    if (challenge.code !== code.trim()) return { ok: false, code: 'code-mismatch' }
    this.challenges.delete(loginId)
    return { ok: true, userId: challenge.userId }
  }

  /** 6 位数字验证码（注入随机源 → 确定性）。 */
  private mintCode(): string {
    const value = Math.floor(this.random() * 1_000_000)
    return String(value).padStart(6, '0')
  }
}

/** IM 用户 → 银行 userId 映射表（施工单 15 的网关在启动时灌入）。 */
export class ImIdentityMap {
  private readonly byImUser = new Map<string, string>()

  /**
   * 登记一条映射（重复登记同一 IM 用户 = 覆盖，便于渠道改绑）。
   *
   * @throws `BahError('identity-invalid')` IM 用户 ID / 银行 userId 为空
   */
  register(imUserId: string, bankUserId: string): void {
    const im = imUserId.trim()
    const bank = bankUserId.trim()
    if (im.length === 0 || bank.length === 0) {
      throw new BahError('identity-invalid', 'credentials: IM 映射的两个 ID 都不能为空', {
        imUserId,
        bankUserId,
      })
    }
    this.byImUser.set(im, bank)
  }

  /** 解析 IM 用户对应的银行 userId（未登记返回 `undefined`）。 */
  resolve(imUserId: string): string | undefined {
    return this.byImUser.get(imUserId.trim())
  }
}

/** 会话身份绑定端口（宿主用 `BANK_IDENTITY` + `identity/bound` 落账实现）。 */
export interface SessionIdentityBinding {
  /** 绑定并落 durable 事件（重复绑定同一用户幂等）。 */
  bind(sessionId: SessionId, userId: string, method: IdentityBindingMethod): void
}

/** `CredentialsService` 的装配参数。 */
export interface CredentialsServiceOptions {
  readonly login: MockSmsLoginService
  readonly im: ImIdentityMap
  readonly binding: SessionIdentityBinding
}

/** IM 绑定结果。 */
export type ImBindResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly code: 'im-user-unknown' }

/**
 * 凭证服务（服务键 `CREDENTIALS`）：渠道（Web / IM / headless）都从这里发起登录。
 *
 * 登录成功 = 会话已绑定 + `identity/bound` 已落账；失败 = 什么都没发生（默认拒绝）。
 */
export class CredentialsService {  private readonly login: MockSmsLoginService
  private readonly im: ImIdentityMap
  private readonly binding: SessionIdentityBinding

  constructor(options: CredentialsServiceOptions) {
    this.login = options.login
    this.im = options.im
    this.binding = options.binding
  }

  /** 申请短信登录验证码。 */
  requestSmsLogin(phone: string): SmsChallengeResult {
    return this.login.request(phone)
  }

  /** 校验验证码；成功则把当前会话绑定到该用户（method = `mock-login`）。 */
  completeSmsLogin(sessionId: SessionId, loginId: string, code: string): SmsLoginResult {
    const result = this.login.verify(loginId, code)
    if (!result.ok) return result
    this.binding.bind(sessionId, result.userId, 'mock-login')
    return result
  }

  /** 按 IM 用户 ID 绑定当前会话（method = `im-map`）。 */
  bindImUser(sessionId: SessionId, imUserId: string): ImBindResult {
    const userId = this.im.resolve(imUserId)
    if (userId === undefined) return { ok: false, code: 'im-user-unknown' }
    this.binding.bind(sessionId, userId, 'im-map')
    return { ok: true, userId }
  }

  /** 登记 IM 映射（施工单 15 的网关在启动时调用；重复登记 = 覆盖）。 */
  registerImUser(imUserId: string, bankUserId: string): void {
    this.im.register(imUserId, bankUserId)
  }

  /**
   * Web / 桌面端登录页的接缝（施工单 13）：渠道拿到 userId 后调这里。
   *
   * @throws `BahError('identity-invalid')` userId 为空
   */
  bindSession(sessionId: SessionId, userId: string): void {
    const normalized = userId.trim()
    if (normalized.length === 0) {
      throw new BahError('identity-invalid', 'credentials: 用户 ID 不能为空', { sessionId })
    }
    this.binding.bind(sessionId, normalized, 'mock-login')
  }
}

/** 服务键：`persistence:credentials`（渠道插件按需取用；施工单 13/15 接线）。 */
export const CREDENTIALS: ServiceKey<CredentialsService> = defineService<CredentialsService>(
  'persistence:credentials',
)
