/**
 * 强验证工具。
 *
 * 三个工具本身是**绿级**（只是验证渠道，不是敏感操作），但独立调用没有挑战链
 * 会返回 `no-challenge`；真正把它们串进红色操作的是 09 的审批/挑战链。
 *
 * 连续失败 ≥ 3 由 `VerifyService` 判定并锁会话；工具负责把 `verify/locked` 落账。
 */

import type { ToolDefinition } from '@bah/core'

import { assertNever } from '@bah/util'

import type { StrongAuth } from '../core/index.ts'
import { readString } from './args.ts'
import type { VerifyResult } from './dto.ts'
import { verifyCard } from './presenters.ts'
import { specOf } from './specs.ts'
import type { BankToolDeps } from './types.ts'

/** 渠道 → 工具名。 */
const TOOL_OF_CHANNEL: Readonly<Record<StrongAuth, 'verify_face' | 'verify_sms' | 'verify_ushield'>> = {
  face: 'verify_face',
  sms: 'verify_sms',
  ushield: 'verify_ushield',
}

/** 造一个渠道的验证工具。 */
export function createVerifyTool(
  deps: BankToolDeps,
  channel: StrongAuth,
): ToolDefinition<Readonly<Record<string, unknown>>, VerifyResult> {
  const spec = specOf(TOOL_OF_CHANNEL[channel])
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const challengeId = readString(args, 'challengeId', spec.name)
      const submitted = await deps.verify.submit(ctx.sessionId, challengeId, channel)
      const result = submitted.result
      switch (channel) {
        case 'face':
          deps.audit.append('verify/face', { result })
          break
        case 'sms':
          deps.audit.append('verify/sms', { result })
          break
        case 'ushield':
          deps.audit.append('verify/ushield', { result })
          break
        default:
          assertNever(channel, 'verify-channel')
      }
      if (submitted.justLocked && result.lockedUntil !== undefined) {
        deps.audit.append('verify/locked', {
          sessionId: ctx.sessionId,
          channel,
          until: result.lockedUntil,
          attempts: result.attempts,
        })
      }
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text: result.success
          ? `${spec.name} 通过（第 ${result.attempts} 次）。`
          : `${spec.name} 失败（第 ${result.attempts} 次），剩余 ${result.remainingAttempts} 次` +
            (result.lockedUntil === undefined ? '。' : '；红色操作已锁定，请稍后再试。'),
      },
    ],
    presentResult: (_args, result) => verifyCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, VerifyResult>
}
