/**
 * 强验证渠道。
 *
 * 三条纪律：
 * 1. **全 mock + 拟真**：Provider 决定“这次验证成功还是失败”，默认实现确定性成功（第 1 次通过）；
 * 2. **挑战只能被签发它的会话使用**：跨会话 / 跨渠道 / 重复提交都 fail-loud；
 * 3. **连续失败 ≥ maxAttempts → 锁该会话的红色操作 lockMs**，并让调用方落 `verify/locked`。
 *
 * 挑战的签发（红级 `ask`）与审批弹窗的串联属；本模块只提供被调用的能力。
 */

import { BahError } from '@bah/util'

import type { SessionId } from '@bah/core'

import type { StrongAuth } from '../core/model.ts'
import type { VerifyResult } from '../tools/dto.ts'

/** 一条强验证挑战。 */
export interface VerifyChallenge {
  readonly id: string
  readonly sessionId: SessionId
  readonly channel: StrongAuth
  /** 已尝试次数。 */
  readonly attempts: number
  readonly status: 'pending' | 'passed' | 'failed'
  readonly createdAt: number
}

/** 单次验证请求（Provider 的输入）。 */
export interface VerifyAttempt {
  readonly challengeId: string
  readonly channel: StrongAuth
  /** 第几次尝试（从 1 开始）。 */
  readonly attempt: number
}

/** 单次验证结论。 */
export interface VerifyOutcome {
  readonly success: boolean
}

/** 验证渠道 Provider（人脸 / 短信 / U 盾的真实实现只换这一个接口）。 */
export interface VerifyProvider {
  verify(attempt: VerifyAttempt): Promise<VerifyOutcome>
}

/** `submit` 的返回：结果 + 本次是否刚触发锁定（决定要不要落 `verify/locked`）。 */
export interface VerifySubmitResult {
  readonly result: VerifyResult
  readonly justLocked: boolean
}

/** `VerifyService` 的装配参数。 */
export interface VerifyServiceOptions {
  readonly provider?: VerifyProvider
  /** 允许的连续失败次数（缺省 3）。 */
  readonly maxAttempts?: number
  /** 锁定时长（ms；缺省 30 分钟）。 */
  readonly lockMs?: number
  readonly now?: () => number
}

/**
 * 确定性 mock Provider：第 `successAfter` 次尝试起成功（缺省 1 = 首次成功）。
 *
 * 失败用例注入 `successAfter: Number.MAX_SAFE_INTEGER` 或自定义 Provider。
 */
export function createMockVerifyProvider(
  options: { readonly successAfter?: number } = {},
): VerifyProvider {
  const successAfter = options.successAfter ?? 1
  return {
    verify: (attempt) => Promise.resolve({ success: attempt.attempt >= successAfter }),
  }
}

/**
 * 验证挑战与锁定状态机（内存实现；09 的真实 Provider 可替换，状态机语义不变）。
 */
export class VerifyService {
  private readonly provider: VerifyProvider
  private readonly maxAttempts: number
  private readonly lockMs: number
  private readonly now: () => number
  private readonly challenges = new Map<string, VerifyChallenge>()
  private readonly locks = new Map<SessionId, number>()
  /** 正在 `await provider.verify` 的挑战：同一挑战的并发提交必须被拒。 */
  private readonly inFlight = new Set<string>()
  private sequence = 0

  constructor(options: VerifyServiceOptions = {}) {
    this.provider = options.provider ?? createMockVerifyProvider()
    this.maxAttempts = options.maxAttempts ?? 3
    this.lockMs = options.lockMs ?? 30 * 60 * 1000
    this.now = options.now ?? (() => Date.now())
  }

  /** 签发一条挑战（由红级判定调用；09 接线）。 */
  issue(sessionId: SessionId, channel: StrongAuth): VerifyChallenge {
    this.sequence += 1
    const challenge: VerifyChallenge = {
      id: `vc-${this.sequence}`,
      sessionId,
      channel,
      attempts: 0,
      status: 'pending',
      createdAt: this.now(),
    }
    this.challenges.set(challenge.id, challenge)
    return challenge
  }

  /** 读取挑战（不存在返回 `undefined`；审计 / 调试用）。 */
  get(challengeId: string): VerifyChallenge | undefined {
    return this.challenges.get(challengeId)
  }

  /** 会话是否处于红色操作锁定中（过期自动解除）。 */
  isLocked(sessionId: SessionId): boolean {
    return this.lockedUntil(sessionId) !== undefined
  }

  /** 锁定截止时刻（未锁定返回 `undefined`）。 */
  lockedUntil(sessionId: SessionId): number | undefined {
    const until = this.locks.get(sessionId)
    if (until === undefined) return undefined
    if (until <= this.now()) {
      this.locks.delete(sessionId)
      return undefined
    }
    return until
  }

  /**
   * 提交一次验证。
   *
   * @throws `BahError('verify-locked')` 会话锁定中
   * @throws `BahError('no-challenge')` 挑战不存在 / 不属于本会话
   * @throws `BahError('challenge-channel-mismatch')` 渠道不符
   * @throws `BahError('challenge-consumed')` 挑战已结束
   * @throws `BahError('challenge-busy')` 同一挑战已有一次验证在途
   */
  async submit(
    sessionId: SessionId,
    challengeId: string,
    channel: StrongAuth,
  ): Promise<VerifySubmitResult> {
    const lockedUntil = this.lockedUntil(sessionId)
    if (lockedUntil !== undefined) {
      throw new BahError('verify-locked', 'bank-tools: 强验证连续失败，红色操作已锁定', {
        sessionId,
        lockedUntil,
      })
    }

    const challenge = this.challenges.get(challengeId)
    if (challenge === undefined || challenge.sessionId !== sessionId) {
      throw new BahError('no-challenge', `bank-tools: 没有可用的验证挑战 ${challengeId}`, {
        challengeId,
      })
    }
    if (challenge.channel !== channel) {
      throw new BahError(
        'challenge-channel-mismatch',
        `bank-tools: 挑战 ${challengeId} 的渠道是 ${challenge.channel}，不能走 ${channel}`,
        { challengeId, expected: challenge.channel, actual: channel },
      )
    }
    if (challenge.status !== 'pending') {
      throw new BahError('challenge-consumed', `bank-tools: 挑战 ${challengeId} 已结束`, {
        challengeId,
        status: challenge.status,
      })
    }
    // 原子占位：并发提交若都读到 attempts=0，失败计数会互相覆盖（锁定阈值永远凑不齐）；
    // 通过后再来一次失败提交还会把 passed 写回 pending（已消费的挑战被复活）。
    if (this.inFlight.has(challengeId)) {
      throw new BahError('challenge-busy', `bank-tools: 挑战 ${challengeId} 已有验证在途`, {
        challengeId,
      })
    }
    this.inFlight.add(challengeId)

    try {
      const attempt = challenge.attempts + 1
      const outcome = await this.provider.verify({ challengeId, channel, attempt })

      // provider 返回后重新读取：状态可能已被同一服务的其他路径改写
      const latest = this.challenges.get(challengeId)
      if (latest === undefined || latest.status !== 'pending') {
        throw new BahError('challenge-consumed', `bank-tools: 挑战 ${challengeId} 已结束`, {
          challengeId,
          status: latest?.status ?? 'missing',
        })
      }
      const settledAttempts = latest.attempts + 1

      if (outcome.success) {
        this.replace(challengeId, { attempts: settledAttempts, status: 'passed' })
        return {
          result: {
            channel,
            challengeId,
            success: true,
            attempts: settledAttempts,
            remainingAttempts: Math.max(0, this.maxAttempts - settledAttempts),
          },
          justLocked: false,
        }
      }

      if (settledAttempts >= this.maxAttempts) {
        this.replace(challengeId, { attempts: settledAttempts, status: 'failed' })
        const until = this.now() + this.lockMs
        this.locks.set(sessionId, until)
        return {
          result: {
            channel,
            challengeId,
            success: false,
            attempts: settledAttempts,
            remainingAttempts: 0,
            lockedUntil: until,
          },
          justLocked: true,
        }
      }

      this.replace(challengeId, { attempts: settledAttempts })
      return {
        result: {
          channel,
          challengeId,
          success: false,
          attempts: settledAttempts,
          remainingAttempts: this.maxAttempts - settledAttempts,
        },
        justLocked: false,
      }
    } finally {
      this.inFlight.delete(challengeId)
    }
  }

  /** 只改目标字段：绝不把调用方手里的旧快照整体写回。 */
  private replace(challengeId: string, patch: Partial<VerifyChallenge>): void {
    const current = this.challenges.get(challengeId)
    if (current === undefined) return
    this.challenges.set(challengeId, { ...current, ...patch })
  }
}

export * from './port.ts'
