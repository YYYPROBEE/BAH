/**
 * 银行工具族的治理平面（施工单 09 §1–§3）。
 *
 * 三个挂点，全部经 `ctx.events`（不私建旁路）：
 * 1. `tools/pre-execute`（waterfall）：身份 → 预检 → `decide()` 判定矩阵 → `allow / ask / deny`；
 *    每次判决落 `tier/decided` 审计事件；
 * 2. `approval/request`（waterfall）：把管线铸造的三字段票据桥接成 bank-core 的五绑定票据，
 *    再交给下游（`@bah/interaction` 的审批服务）仲裁；应答后同步 `issued → approved / blocked`；
 * 3. `tools/result`（emit）：按 core 的票据状态记账（`redeemed + 成功 → consumed`，其余 → `blocked`）。
 *
 * 票据生命周期账本（`ticket/*` 事件）由宿主注入（`@bah/interaction` 的 `TicketLedger`）：
 * 本包只负责**五绑定组装与核销边界**，不持有跨 turn 的待审批状态（R90）。
 */

import { BahError } from '@bah/util'

import type { Context, SessionId, TicketDraft, TicketId, ToolTierLevel } from '@bah/core'

import type { TransferPreview } from '../core/provider.ts'
import { yuanToCents } from '../core/index.ts'
import { requireAccount } from './accounts.ts'
import { readString } from './args.ts'
import { fingerprintOf } from './fingerprint.ts'
import { assertExecutableNow, parsePurchaseAmount, parseTransferInput } from './inputs.ts'
import { BANK_TOOL_NAME_SET, specOf, type BankToolName, type BankToolSpec } from './specs.ts'
import { decide, isRiskyOp, type TierConfig, type TierReason } from './tier.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** 本地结构类型：避免把 `@bah/runtime` 拖进本包（接缝形状与 `seams.ts` 一致）。 */
interface ToolCallLike {
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

type DenyVerdict = { readonly kind: 'deny'; readonly reason: string; readonly code: string }

type VerdictLike =
  | { readonly kind: 'allow' }
  | DenyVerdict
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

/**
 * 票据生命周期端口（宿主传入 `@bah/interaction` 的 `TicketLedger`）。
 *
 * 本包声明**结构类型**而不是 import interaction：判定/治理不该反向依赖交互包，
 * 宿主是唯一知道两个包的地方（接缝形状与 `@bah/core` 的 `TicketRef` 无关）。
 */
export interface TicketLifecycleIssueInput {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly fingerprint: string
  readonly amountCents?: number
  readonly expiresAt: number
  readonly at: number
}

/** 票据生命周期账本的最小面（见 `@bah/interaction` 的 `TicketLedger`）。 */
export interface TicketLifecycle {
  issue(input: TicketLifecycleIssueInput): unknown
  approve(ticketId: string, at: number): unknown
  redeem(ticketId: string, at: number): unknown
  consume(ticketId: string, at: number): unknown
  block(ticketId: string, reason: string, at: number): unknown
}

/** 装配参数。 */
export interface BankGovernanceOptions {
  readonly ctx: Context
  readonly sessionId: SessionId
  readonly deps: BankToolDeps
  /** 票据生命周期账本（缺省 = 只记 bank-core 状态，不落 `ticket/*` 事件；单测可用）。 */
  readonly lifecycle?: TicketLifecycle
}

/** 一次判决的完整审计记录（`tier/decided` 的载荷）。 */
interface DecisionAudit {
  readonly verdict: VerdictLike
  readonly level: ToolTierLevel
  readonly reason: TierReason
  readonly code?: string
}

/**
 * 装配治理平面（幂等注册；随 ctx dispose 自动撤销）。
 *
 * @throws 仅在装配期抛（配置 / 依赖错误）；运行期判决一律走 `allow / ask / deny`
 */
export function provideBankGovernance(options: BankGovernanceOptions): void {
  const { ctx, sessionId, deps, lifecycle } = options
  const now = clockOf(deps)
  const tierConfig: TierConfig = {
    dailyTransferLimitCents: yuanToCents(deps.config.dailyTransferLimit),
    riskyOps: deps.config.riskyOps,
    riskyCallThreshold: deps.config.riskyCallThreshold,
  }
  /** 组合风险是「同一 turn 内」的口径：turn/start 重置（跨 turn 的日累计由 core 账本负责）。 */
  let riskyCallsInTurn = 0

  ctx.effect(
    ctx.events.on('session/event', (payload) => {
      const envelope = payload as { readonly event?: { readonly type?: unknown } }
      if (envelope.event?.type === 'turn/start') riskyCallsInTurn = 0
    }),
  )

  // ① 执行前判决：下游（危险规则 / sentry）先说话；下游 deny 永远赢
  ctx.effect(
    ctx.events.on('tools/pre-execute', async (payload, next) => {
      const input = payload as PreExecuteLike
      const downstream = (await next(payload)) as PreExecuteLike
      if (!BANK_TOOL_NAME_SET.has(input.call.name)) return downstream
      if (downstream.verdict.kind !== 'allow') return downstream

      const spec = specOf(input.call.name as BankToolName)
      const audit = await evaluateCall(deps, sessionId, input.call, spec, tierConfig, riskyCallsInTurn, now)
      deps.audit.append('tier/decided', {
        callId: input.call.callId,
        name: spec.name,
        level: audit.level,
        reason: audit.reason,
        verdict: audit.verdict.kind,
        ...(audit.code === undefined ? {} : { code: audit.code }),
        at: now(),
      })

      if (audit.verdict.kind !== 'deny' && isRiskyOp(tierConfig, spec.name)) {
        riskyCallsInTurn += 1
      }
      return audit.verdict.kind === 'allow' ? downstream : { ...downstream, verdict: audit.verdict }
    }),
  )

  // ② 审批桥接：三字段票据 → 五绑定票据；应答后同步状态 + 记账
  ctx.effect(
    ctx.events.on('approval/request', async (payload, next) => {
      const input = payload as ApprovalLike
      if (!BANK_TOOL_NAME_SET.has(input.name)) return next(payload)

      const ticketId = input.ticket.ticketId as TicketId
      const issuedAt = now()
      const binding = {
        sessionId,
        tool: input.name,
        fingerprint: input.ticket.fingerprint,
        amountCents: centsOf(input.ticket.amount),
        expiresAt: input.ticket.expiresAt,
      }
      if (deps.tickets.get(ticketId) === undefined) {
        try {
          deps.tickets.issue(ticketId, binding, issuedAt)
        } catch (error) {
          return {
            ...input,
            decision: { decision: 'unavailable', reason: reasonOf(error) },
          }
        }
        lifecycle?.issue({
          ticketId,
          callId: input.callId,
          name: input.name,
          fingerprint: binding.fingerprint,
          amountCents: binding.amountCents,
          expiresAt: binding.expiresAt,
          at: issuedAt,
        })
      }

      const answered = (await next(payload)) as ApprovalLike
      const decidedAt = now()
      if (answered.decision.decision === 'allowed-once') {
        try {
          deps.tickets.approve(ticketId, decidedAt)
          lifecycle?.approve(ticketId, decidedAt)
        } catch (error) {
          // 票据过期等：宁可拒绝，也不带着无效票据去执行
          lifecycle?.block(ticketId, reasonOf(error), decidedAt)
          return {
            ...answered,
            decision: { decision: 'unavailable', reason: reasonOf(error) },
          }
        }
      } else {
        const reason = answered.decision.reason ?? `approval-${answered.decision.decision}`
        try {
          deps.tickets.block(ticketId, reason, decidedAt)
        } catch {
          // 已关闭的票据（重复应答 / 已核销）不再改写状态；审批结论照常返回
        }
        lifecycle?.block(ticketId, reason, decidedAt)
      }
      return answered
    }),
  )

  // ③ 结果记账（施工单 09 §3 第 4 步）：成功 → consumed；失败 / 拒绝 / 超时 → blocked
  ctx.effect(
    ctx.events.on('tools/result', (payload) => {
      const result = payload as ToolResultLike
      const ticketId = ticketIdOf(result.callId)
      const status = deps.tickets.status(ticketId)
      if (status === undefined) return
      const at = now()
      if (status === 'redeemed') {
        lifecycle?.redeem(ticketId, at)
        if (result.isError) lifecycle?.block(ticketId, result.code ?? 'tool-failed', at)
        else lifecycle?.consume(ticketId, at)
        return
      }
      if (status === 'approved') {
        lifecycle?.block(ticketId, result.isError ? (result.code ?? 'tool-failed') : 'not-redeemed', at)
        return
      }
      if (status === 'issued') lifecycle?.block(ticketId, 'approval-not-completed', at)
    }),
  )
}

/**
 * 一次调用的完整判定（身份 → 预检 → `decide()`）。
 *
 * 预检（余额 / 收款人 / 理财产品）属于“这一笔注定失败”的拒绝，必须在签发票据前完成；
 * 判决本身是纯函数（`tier.ts`），这里只做异步取数。
 */
async function evaluateCall(
  deps: BankToolDeps,
  sessionId: SessionId,
  call: ToolCallLike,
  spec: BankToolSpec,
  config: TierConfig,
  riskyCallsInTurn: number,
  now: () => number,
): Promise<DecisionAudit> {
  const userId = deps.identity.resolve(sessionId)
  if (userId === undefined || userId.trim().length === 0) {
    return {
      verdict: { kind: 'deny', code: 'no-identity', reason: '当前会话未绑定银行用户身份' },
      level: spec.tier.level,
      reason: 'declared',
      code: 'no-identity',
    }
  }

  let preview: TransferPreview | undefined
  let amountCents = 0
  if (spec.name === 'transfer_create') {
    const checked = await transferPreview(deps, userId, call, now)
    if ('deny' in checked) {
      return {
        verdict: checked.deny,
        level: spec.tier.level,
        reason: 'declared',
        code: checked.deny.code,
      }
    }
    preview = checked.preview
    amountCents = checked.preview.amountCents
  }

  if (spec.name === 'wealth_purchase') {
    const checked = await checkWealthPurchase(deps, call)
    if ('deny' in checked) {
      return { verdict: checked.deny, level: spec.tier.level, reason: 'declared', code: checked.deny.code }
    }
    amountCents = checked.amountCents
  }

  const decision = decide({
    name: spec.name,
    declared: spec.tier.level,
    config,
    state: {
      userId,
      riskyCallsInTurn,
      verifyLocked: deps.verify.isLocked(sessionId),
    },
    ...(preview === undefined ? {} : { preview }),
  })

  switch (decision.kind) {
    case 'allow':
      return { verdict: { kind: 'allow' }, level: decision.level, reason: decision.reason }
    case 'ask':
      return {
        verdict: {
          kind: 'ask',
          ticket: {
            fingerprint: fingerprintOf(call.name, call.args),
            amount: amountCents / 100,
            ttlMs: deps.config.ticketTtlSeconds * 1000,
          },
          ...(decision.challenge ? { challenge: deps.config.redChallenge } : {}),
        },
        level: decision.level,
        reason: decision.reason,
      }
    case 'deny':
      return {
        verdict: { kind: 'deny', code: decision.code, reason: decision.reason },
        level: decision.level,
        reason: 'declared',
        code: decision.code,
      }
  }
}

/**
 * 转账的执行前预检（余额 / 风控 block 规则 / 参数）。
 *
 * 只返回预检结果或拒绝：日累计 / 新收款人的**级别**由 `decide()` 的升级规则统一判定，
 * 这样试算卡片与执行判定共用同一口径（`transfers.ts` 的 `toTransferPreview`）。
 */
async function transferPreview(
  deps: BankToolDeps,
  userId: string,
  call: ToolCallLike,
  now: () => number,
): Promise<{ readonly preview: TransferPreview } | { readonly deny: DenyVerdict }> {
  let input
  try {
    input = parseTransferInput(call.args)
    assertExecutableNow(input.when, now())
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error), reason: reasonOf(error) } }
  }
  let account
  try {
    account = await requireAccount(deps, userId)
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error), reason: reasonOf(error) } }
  }
  try {
    const preview = await deps.core.previewTransfer({
      fromAccountId: account.id,
      payee: input.payee,
      amountCents: input.amountCents,
      channel: 'app',
    })
    const blocked = preview.risks.find(
      (risk) => risk.severity === 'block' && risk.rule !== 'daily-limit',
    )
    if (blocked !== undefined) {
      return { deny: { kind: 'deny', code: blocked.code, reason: blocked.message } }
    }
    return { preview }
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error), reason: reasonOf(error) } }
  }
}

/** 理财购买的产品存在性 / 起投额预检（不存在或低于起投额直接拒绝，不签票据）。 */
async function checkWealthPurchase(
  deps: BankToolDeps,
  call: ToolCallLike,
): Promise<{ readonly amountCents: number } | { readonly deny: DenyVerdict }> {
  try {
    const amountCents = parsePurchaseAmount(call.args)
    const productId = readString(call.args, 'productId', 'wealth_purchase')
    const product = (await deps.core.listWealthProducts()).find((item) => item.id === productId)
    if (product === undefined) {
      return {
        deny: { kind: 'deny', code: 'product-unknown', reason: `未知理财产品 ${productId}` },
      }
    }
    if (amountCents < product.minAmountCents) {
      return {
        deny: {
          kind: 'deny',
          code: 'below-minimum',
          reason: `低于起投额（${product.minAmountCents} 分）`,
        },
      }
    }
    return { amountCents }
  } catch (error) {
    return { deny: { kind: 'deny', code: 'tool-args-invalid', reason: reasonOf(error) } }
  }
}

/** 元 → 分（票据桥接；缺省金额按 0 处理，真正的金额校验在工具体）。 */
function centsOf(amount: number | undefined): number {
  return amount === undefined ? 0 : Math.round(amount * 100)
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
