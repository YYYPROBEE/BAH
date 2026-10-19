/**
 * 银行工具族的治理平面（施工单 09 §1–§3 中 08 必须先落地的部分）。
 *
 * 两个挂点，全部经 `ctx.events`（不私建旁路）：
 * 1. `tools/pre-execute`（waterfall）：身份 → 声明级别 → 转账升级 → `allow / ask / deny`；
 *    黄级签发票据草稿，红级附加强验证挑战；
 * 2. `approval/request`（waterfall）：把管线签发的三字段票据桥接成 bank-core 的五绑定票据，
 *    并在应答后同步 `issued → approved / blocked`。
 *
 * 09 的 `risky_calls`、身份绑定渠道、审批服务与挑战链会在这个入口继续扩展；
 * 本文件只做「工具声明 + 金额/收款人升级 + 票据生命周期」这一段，判定函数在 `tier.ts`。
 */

import { BahError } from '@bah/util'

import type { Context, SessionId, TicketDraft, TicketId, ToolTierLevel } from '@bah/core'

import type { TransferPreview } from '../core/provider.ts'
import { requireAccount } from './accounts.ts'
import { readString } from './args.ts'
import { fingerprintOf } from './fingerprint.ts'
import { assertExecutableNow, parsePurchaseAmount, parseTransferInput } from './inputs.ts'
import { BANK_TOOL_NAME_SET, BANK_TOOL_SPECS } from './specs.ts'
import { escalateTransferTier, requiresChallenge } from './tier.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** 本地结构类型：避免把 `@bah/runtime` 拖进本包（接缝形状与 `seams.ts` 一致）。 */
interface ToolCallLike {
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

type VerdictLike =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string; readonly code: string }
  | {
      readonly kind: 'ask'
      readonly ticket: TicketDraft
      readonly challenge?: 'face' | 'sms' | 'ushield'
    }

interface PreExecuteLike {
  readonly call: ToolCallLike
  readonly verdict: VerdictLike
}

interface ApprovalLike {
  readonly ticket: {
    readonly ticketId: string
    readonly fingerprint: string
    readonly amount?: number
    readonly expiresAt: number
  }
  readonly callId: string
  readonly name: string
  readonly decision: {
    readonly decision: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    readonly reason?: string
  }
}

interface ToolResultLike {
  readonly callId: string
  readonly isError: boolean
  readonly code?: string
}

/** 一次 ask 判决的待审批上下文（票据签发时要用银行侧的参数指纹）。 */
interface PendingApproval {
  readonly fingerprint: string
  readonly amountCents: number
}

/** 装配参数。 */
export interface BankGovernanceOptions {
  readonly ctx: Context
  readonly sessionId: SessionId
  readonly deps: BankToolDeps
}

/**
 * 装配治理平面（幂等注册；随 ctx dispose 自动撤销）。
 *
 * @throws 仅在装配期抛（配置 / 依赖错误）；运行期判决一律走 `allow / ask / deny`
 */
export function provideBankGovernance(options: BankGovernanceOptions): void {
  const { ctx, sessionId, deps } = options
  const now = clockOf(deps)
  const pending = new Map<string, PendingApproval>()

  // ① 执行前判决：下游（危险规则 / sentry）先说话；下游 deny 永远赢
  ctx.effect(
    ctx.events.on('tools/pre-execute', async (payload, next) => {
      const input = payload as PreExecuteLike
      const downstream = (await next(payload)) as PreExecuteLike
      if (!BANK_TOOL_NAME_SET.has(input.call.name)) return downstream
      if (downstream.verdict.kind !== 'allow') return downstream

      const verdict = await decidePreExecute(deps, sessionId, input.call, now())
      if (verdict.kind === 'ask') {
        pending.set(input.call.callId, {
          fingerprint: fingerprintOf(input.call.name, input.call.args),
          amountCents: amountCentsOf(verdict),
        })
      }
      return verdict.kind === 'allow' ? downstream : { ...downstream, verdict }
    }),
  )

  // ② 审批桥接：三字段票据 → 五绑定票据；应答后同步状态
  ctx.effect(
    ctx.events.on('approval/request', async (payload, next) => {
      const input = payload as ApprovalLike
      if (!BANK_TOOL_NAME_SET.has(input.name)) return next(payload)

      const item = pending.get(input.callId)
      if (item === undefined) {
        return {
          ...input,
          decision: { decision: 'rejected', reason: 'bank-ticket-context-missing' },
        }
      }

      const ticketId = input.ticket.ticketId as TicketId
      if (deps.tickets.get(ticketId) === undefined) {
        try {
          deps.tickets.issue(
            ticketId,
            {
              sessionId,
              tool: input.name,
              fingerprint: item.fingerprint,
              amountCents: item.amountCents,
              expiresAt: input.ticket.expiresAt,
            },
            now(),
          )
        } catch (error) {
          return {
            ...input,
            decision: { decision: 'unavailable', reason: reasonOf(error) },
          }
        }
      }

      const answered = (await next(payload)) as ApprovalLike
      if (answered.decision.decision === 'allowed-once') {
        try {
          deps.tickets.approve(ticketId, now())
        } catch (error) {
          // 票据过期等：宁可拒绝，也不带着无效票据去执行
          return {
            ...answered,
            decision: { decision: 'unavailable', reason: reasonOf(error) },
          }
        }
      } else {
        try {
          deps.tickets.block(ticketId, answered.decision.reason ?? answered.decision.decision, now())
        } catch {
          // 已关闭的票据（重复应答 / 已核销）不再改写状态；审批结论照常返回
        }
      }
      return answered
    }),
  )

  // ③ 结果记账 + 待审批上下文清理（施工单 09 §3 第 4 步：失败 → blocked）
  ctx.effect(
    ctx.events.on('tools/result', (payload) => {
      const result = payload as ToolResultLike
      pending.delete(result.callId)
      const ticketId = ticketIdOf(result.callId)
      if (deps.tickets.status(ticketId) !== 'approved') return
      try {
        deps.tickets.block(ticketId, result.isError ? (result.code ?? 'tool-failed') : 'not-redeemed', now())
      } catch {
        // 状态已变化（并发收尾）：不改写，保持票据状态机为唯一真相
      }
    }),
  )
}

/** 判定一次调用（纯逻辑 + bank-core 只读预检）。 */
async function decidePreExecute(
  deps: BankToolDeps,
  sessionId: SessionId,
  call: ToolCallLike,
  now: number,
): Promise<VerdictLike> {
  const spec = BANK_TOOL_SPECS.find((item) => item.name === call.name)
  if (spec === undefined) return { kind: 'allow' }

  const userId = deps.identity.resolve(sessionId)
  if (userId === undefined || userId.trim().length === 0) {
    return { kind: 'deny', code: 'no-identity', reason: '当前会话未绑定银行用户身份' }
  }

  const declared: ToolTierLevel = spec.tier.level
  if (declared === 'green') return { kind: 'allow' }

  let tier: 'green' | 'yellow' | 'red' = declared
  if (spec.name === 'transfer_create') {
    const escalated = await transferTier(deps, userId, call, now)
    if ('deny' in escalated) return escalated.deny
    tier = escalated.level
  }
  if (spec.name === 'wealth_purchase') {
    try {
      const amountCents = parsePurchaseAmount(call.args)
      const productId = readString(call.args, 'productId', 'wealth_purchase')
      const product = (await deps.core.listWealthProducts()).find((item) => item.id === productId)
      if (product === undefined) {
        return {
          kind: 'deny',
          code: 'product-unknown',
          reason: `未知理财产品 ${productId}`,
        }
      }
      if (amountCents < product.minAmountCents) {
        return {
          kind: 'deny',
          code: 'below-minimum',
          reason: `低于起投额（${product.minAmountCents} 分）`,
        }
      }
    } catch (error) {
      return { kind: 'deny', code: 'tool-args-invalid', reason: reasonOf(error) }
    }
  }

  if (requiresChallenge(tier) && deps.verify.isLocked(sessionId)) {
    return {
      kind: 'deny',
      code: 'verify-locked',
      reason: '强验证连续失败，红色操作已锁定，请稍后再试或联系客服',
    }
  }
  if (tier === 'green') return { kind: 'allow' }

  const amountCents = amountCentsOfArgs(call.args)
  return {
    kind: 'ask',
    ticket: {
      fingerprint: fingerprintOf(call.name, call.args),
      amount: amountCents / 100,
      ttlMs: deps.config.ticketTtlSeconds * 1000,
    },
    ...(requiresChallenge(tier) ? { challenge: deps.config.redChallenge } : {}),
  }
}

/**
 * 转账类的升级判定。
 *
 * 返回 `{ level }` 或 `{ deny }`：余额不足等 `block` 级风险（日限额除外）在执行前直接拒绝，
 * 避免"用户确认了一笔注定失败的转账"。
 */
async function transferTier(
  deps: BankToolDeps,
  userId: string,
  call: ToolCallLike,
  now: number,
): Promise<{ readonly level: 'green' | 'yellow' | 'red' } | { readonly deny: VerdictLike }> {
  let input
  try {
    input = parseTransferInput(call.args)
    assertExecutableNow(input.when, now)
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error), reason: reasonOf(error) } }
  }
  let account
  try {
    account = await requireAccount(deps, userId)
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error), reason: reasonOf(error) } }
  }
  let preview: TransferPreview
  try {
    preview = await deps.core.previewTransfer({
      fromAccountId: account.id,
      payee: input.payee,
      amountCents: input.amountCents,
      channel: 'app',
    })
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error), reason: reasonOf(error) } }
  }

  const blocked = preview.risks.find(
    (risk) => risk.severity === 'block' && risk.rule !== 'daily-limit',
  )
  if (blocked !== undefined) {
    return { deny: { kind: 'deny', code: blocked.code, reason: blocked.message } }
  }
  return { level: escalateTransferTier('yellow', preview).level }
}

/** `ask` 判决里的金额（分）：从票据草稿的元反推，不用再解析一次参数。 */
function amountCentsOf(verdict: Extract<VerdictLike, { kind: 'ask' }>): number {
  return Math.round((verdict.ticket.amount ?? 0) * 100)
}

/** 参数里的金额（元 → 分）；非法时返回 0（真正的参数校验在工具体）。 */
function amountCentsOfArgs(args: Readonly<Record<string, unknown>>): number {
  const amount = args['amount']
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0
    ? Math.round(amount * 100)
    : 0
}

/** 调用 ID → 票据 ID（与管线 `mintTicket` 同一规则）。 */
function ticketIdOf(callId: string): TicketId {
  return `ticket:${callId}` as TicketId
}

/** `BahError` 的 code；其他错误统一 `tool-failed`。 */
function errorCodeOf(error: unknown): string {
  return error instanceof BahError ? error.code : 'tool-failed'
}

/** 可读理由。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
