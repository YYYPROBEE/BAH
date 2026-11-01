/**
 * `interaction:approval` 的窗口代签桥（`verifyWindow` 的三个 fail-closed 分支）。
 *
 * 为什么必须钉：`plan:dag` 没装（端口缺失）与端口自身抛错时，唯一正确的行为是
 * **沉默**——把票据留给人工或超时。任何"顺手 reject"的改动，都会在用户点开审批卡
 * 之前把票据抢答成拒绝（审批服务先到者胜出），且不会报任何错误。
 *
 * 观测口径：只断言仲裁结论与签署人（`by`）。`allowed-once` 只能来自 `window-responder`；
 * 失败分支必须落回超时（`unavailable`，`by: timeout`），而不是 `rejected`。
 */

import { createContext } from '@bah/core'
import { APPROVAL_SERVICE } from '@bah/interaction'
import { provideSession } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BANK_CHALLENGE } from '@bah/bank'
import type { ApprovalInputLike, ChallengePort } from '@bah/interaction'
import type { Context } from '@bah/core'

import { approvalPlugin } from './approval.ts'
import { WINDOW_SIGNER, type WindowSigner } from './plan-grant.ts'
import { RUN_SERVICE } from '../boot.ts'
import { testRunContext } from '../test-run-context.ts'

const NOW = 1_700_000_000_000
const SESSION = asSessionId('s-window-approval')

/** 挑战端口桩：本组用例只走黄级（无挑战），端口不应被调用。 */
const CHALLENGES: ChallengePort = {
  issue: () => ({ ok: false, code: 'challenge-unavailable', reason: '测试桩' }),
  verify: async () => ({ ok: false, code: 'challenge-unavailable', reason: '测试桩' }),
  passed: () => false,
}

/**
 * 起一个只装了 `interaction:approval` 的上下文。
 *
 * `signer` 不给 = profile 没装 `plan:dag`（窗口代签端口缺失）。
 */
async function withApproval(
  options: { readonly signer?: WindowSigner },
  run: (ctx: Context) => Promise<void>,
): Promise<void> {
  const ctx = createContext()
  const runContext = testRunContext({ sessionId: SESSION, now: () => NOW })
  ctx.provide(RUN_SERVICE, runContext)
  provideSession(ctx, { sessionId: SESSION, now: runContext.now })
  ctx.provide(BANK_CHALLENGE, CHALLENGES)
  if (options.signer !== undefined) ctx.provide(WINDOW_SIGNER, options.signer)
  await ctx.use(approvalPlugin.plugin, approvalPlugin.validate({ windowResponder: true }))
  await ctx.start()
  try {
    await run(ctx)
  } finally {
    await ctx.dispose()
  }
}

/** 一张窗口票据的审批输入（黄级、无挑战）。 */
function windowRequest(expiresAt: number): ApprovalInputLike {
  return {
    ticket: { ticketId: 'ticket:t-window', fingerprint: 'fp-window', expiresAt },
    callId: 'c-window',
    name: 'transfer_create',
    summary: { title: '执行 transfer_create', amount: 30, tier: 'yellow' },
    authorization: { kind: 'window', ref: 'w-1', digest: 'd-1' },
    decision: { decision: 'unavailable' },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('verifyWindow：不可自证就不签字', () => {
  it('没装 plan:dag（端口缺失）⇒ 沉默，票据落回超时 unavailable，不替用户拒绝', async () => {
    vi.useFakeTimers()
    await withApproval({}, async (ctx) => {
      const service = ctx.get(APPROVAL_SERVICE)
      const settled = service.handle(windowRequest(NOW + 500), async (value) => value)
      // 核验失败只意味着"不回答"：等满票据 TTL 后由超时归一化
      await vi.advanceTimersByTimeAsync(500)
      const outcome = await settled

      expect(outcome.decision).toMatchObject({
        decision: 'unavailable',
        reason: 'approval-timeout',
      })
      expect(outcome.by).toBe('timeout')
    })
  })

  it('核验端口抛错 ⇒ 沉默（错误不翻译成用户拒绝）', async () => {
    vi.useFakeTimers()
    await withApproval(
      {
        signer: {
          sign: async () => {
            throw new Error('世界快照读取失败')
          },
        },
      },
      async (ctx) => {
        const service = ctx.get(APPROVAL_SERVICE)
        const settled = service.handle(windowRequest(NOW + 500), async (value) => value)
        await vi.advanceTimersByTimeAsync(500)
        const outcome = await settled

        expect(outcome.decision).toMatchObject({
          decision: 'unavailable',
          reason: 'approval-timeout',
        })
        expect(outcome.by).toBe('timeout')
      },
    )
  })

  it('核验放行 ⇒ 只有这一条路径允许代签：allowed-once + window-authorized，by = window-responder', async () => {
    await withApproval(
      { signer: { sign: async () => ({ ok: true, windowId: 'w-1' }) } },
      async (ctx) => {
        const service = ctx.get(APPROVAL_SERVICE)
        const outcome = await service.handle(windowRequest(NOW + 500), async (value) => value)

        expect(outcome.decision).toMatchObject({
          decision: 'allowed-once',
          reason: 'window-authorized',
        })
        expect(outcome.by).toBe('window-responder')
      },
    )
  })
})
