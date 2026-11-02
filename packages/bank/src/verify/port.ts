/**
 * 强验证的服务接缝：把 `VerifyService` 收成审批服务需要的三个动作。
 *
 * 为什么要有这一层：
 * 1. `@bah/interaction` 不认识银行领域（只认「签发 / 验证 / 是否通过」）；
 * 2. 宿主把本端口注册成服务键 `bank:challenge`，审批服务按需取用；
 * 3. 验证尝试与锁定仍按的事件族落账（`verify/face|sms|ushield|locked`），
 *    这样「审批弹窗里做的强验证」与「模型直接调 verify_* 工具」在审计上同构。
 */

import { defineService } from '@bah/core'

import { assertNever, errorCodeOf } from '@bah/util'

import type { SessionId } from '@bah/core'

import type { StrongAuth } from '../core/model.ts'
import type { VerifyResult } from '../tools/dto.ts'
import type { BankAudit } from '../tools/events.ts'
import type { VerifyService } from './index.ts'

/** 一次挑战的结论（结构化；失败也绝不抛到审批主流程外）。 */
export type BankChallengeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** 结构化理由码（`verify-failed` / `verify-locked` / `no-challenge` / …）。 */
      readonly code: string
      /** 可读理由。 */
      readonly reason: string
      /** 锁定期截止时刻（仅锁定类失败）。 */
      readonly lockedUntil?: number
    }

/** 挑战签发结果。 */
export type BankChallengeIssue =
  | { readonly ok: true; readonly challengeId: string }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * 审批服务需要的挑战端口（结构上与 `@bah/interaction` 的 `ChallengePort` 一致）。
 *
 * 会话 ID 在构造时绑定：一个 host 进程只服务一个会话（`bah:run`）。
 */
export interface BankChallengePort {
  issue(channel: StrongAuth): BankChallengeIssue
  verify(challengeId: string, channel: StrongAuth): Promise<BankChallengeVerdict>
  passed(challengeId: string): boolean
}

/** 服务键：`bank:challenge`（由 `bank:tools` 插件提供，审批插件按需取用）。 */
export const BANK_CHALLENGE = defineService<BankChallengePort>('bank:challenge')

/** 装配参数。 */
export interface BankChallengePortOptions {
  readonly verify: VerifyService
  readonly sessionId: SessionId
  /** 审计出口（验证尝试与锁定事件；缺省 = 不落账，单测用）。 */
  readonly audit?: BankAudit
}

/**
 * 用银行侧 `VerifyService` 造一个挑战端口。
 *
 * 失败一律返回 `{ ok: false }`：审批链路的默认方向是拒绝，端口不把异常抛给主流程。
 */
export function createBankChallengePort(options: BankChallengePortOptions): BankChallengePort {
  const { verify, sessionId } = options
  const audit = options.audit

  return {
    issue(channel) {
      const challenge = verify.issue(sessionId, channel)
      return { ok: true, challengeId: challenge.id }
    },

    async verify(challengeId, channel) {
      try {
        const submitted = await verify.submit(sessionId, challengeId, channel)
        const result = submitted.result
        appendAttempt(audit, channel, result)
        if (submitted.justLocked && result.lockedUntil !== undefined) {
          audit?.append('verify/locked', {
            sessionId,
            channel,
            until: result.lockedUntil,
            attempts: result.attempts,
          })
        }
        if (result.success) return { ok: true }
        return {
          ok: false,
          code: 'verify-failed',
          reason: `第 ${result.attempts} 次验证未通过`,
          ...(result.lockedUntil === undefined ? {} : { lockedUntil: result.lockedUntil }),
        }
      } catch (error) {
        const code = errorCodeOf(error, 'verify-failed')
        const lockedUntil = verify.lockedUntil(sessionId)
        return {
          ok: false,
          code,
          reason: error instanceof Error ? error.message : String(error),
          ...(lockedUntil === undefined ? {} : { lockedUntil }),
        }
      }
    },

    passed(challengeId) {
      return verify.get(challengeId)?.status === 'passed'
    },
  }
}

/** 验证尝试按渠道落账（与 `tools/verification.ts` 的事件族一致）。 */
function appendAttempt(audit: BankAudit | undefined, channel: StrongAuth, result: VerifyResult): void {
  if (audit === undefined) return
  switch (channel) {
    case 'face':
      audit.append('verify/face', { result })
      return
    case 'sms':
      audit.append('verify/sms', { result })
      return
    case 'ushield':
      audit.append('verify/ushield', { result })
      return
    default:
      assertNever(channel, 'verify-channel')
  }
}

