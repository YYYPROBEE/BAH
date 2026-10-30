/**
 * 资产处置类工具（W03 §1.3 的两个新工具 + 场景 5 的 sub_cancel 改造）。
 *
 * - `card_report_lost`（**红档**）：挂失银行卡。不可逆的资产处置，必须审批 +
 *   红级挑战链；档位在 `spec.tier` 里声明，工具内**不许**自带阈值。
 * - `sub_cancel`（**黄档**）：取消自动扣款订阅。合约期内是**硬拦**（不是审批），
 *   支持「立即取消」与「到期即断」两种模式。
 *
 * 两个工具都只做三件事：校验身份 → 调 core 的写入口 → 落领域事件。
 * **不自己改数据结构**：cards / subscriptions 的属主是 `MockBankCore`，
 * 工具层越过去改数组会绕开"写操作必须经 core"的既有纪律。
 */

import type { ToolDefinition } from '@bah/core'
import { BahError } from '@bah/util'

import type { CancelPath, CardId, SubscriptionId, UserId } from '../core/index.ts'
import { DAY_MS } from '../core/index.ts'
import { normalizeMerchant } from '../detect/index.ts'
import { requireUserId } from './accounts.ts'
import { readBoolean, readEnum, readString } from './args.ts'
import { subscriptionCancelConfirmCard } from './presenters.ts'
import { specOf } from './specs.ts'
import { CANCEL_MODES, sanitizeMerchantForPrompt } from './subscriptions.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** `card_report_lost` 的结果。 */
export interface CardReportedLostResult {
  readonly cardId: string
  readonly tail: string
  readonly status: 'lost'
  readonly reportedAt: number
}

/** `sub_cancel` 的结果。 */
export interface SubscriptionCancelledResult {
  readonly subscriptionId: string
  readonly merchant: string
  readonly status: 'cancelled' | 'paused'
  readonly mode: 'now' | 'at-next-cycle'
  readonly path: CancelPath
  readonly cancelRequestId: string
  readonly expectedEffectiveAt: number
  readonly verifyBy: number
  readonly cancelledAt: number
  readonly contractEndAt?: number
  readonly pauseUntil?: number
}

/** 商户支持自助取消的名单（没有银行侧协议时的 B 档；不在名单 → manual）。 */
const SELF_SERVICE_MERCHANTS: ReadonlySet<string> = new Set([
  '视频会员',
  '云音乐',
  '云存储',
  '新闻会员',
  '网盘超级会员',
  '阅读包月',
  'xx软件订阅',
])

/** `card_report_lost`：红档写。 */
export function createCardReportLostTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, CardReportedLostResult> {
  const spec = specOf('card_report_lost')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const cardId = readString(args, 'cardId', spec.name) as CardId
      const lost = await deps.core.reportCardLost(userId, cardId)
      const at = clockOf(deps)()
      // 发射点必须是**字符串字面量**：`verify-session-events` 用 AST 扫
      // `audit.append('…')` 的字面量，动态名会直接判红。
      deps.audit.append('card/reported-lost', {
        cardId: lost.cardId,
        tail: lost.tail,
        status: 'lost',
        at,
      })
      return { cardId: lost.cardId, tail: lost.tail, status: 'lost', reportedAt: at }
    },
    projectContent: (result) => [
      { type: 'text', text: `尾号 ${result.tail} 的银行卡已挂失，该卡即刻不可用。` },
    ],
  }
}

/** `sub_cancel`：黄档写（合约期硬拦 + 立即/到期即断两模式）。 */
export function createSubCancelTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, SubscriptionCancelledResult> {
  const spec = specOf('sub_cancel')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const subscriptionId = readString(args, 'subscriptionId', spec.name) as SubscriptionId
      const confirmContract = readBoolean(args, 'confirmContract', spec.name, false)
      const mode = readEnum(args, 'mode', spec.name, CANCEL_MODES) ?? 'now'
      const at = clockOf(deps)()

      const subscriptions = await deps.core.listSubscriptions(userId)
      const subscription = subscriptions.find((item) => item.id === subscriptionId)
      if (subscription === undefined) {
        throw new BahError('subscription-unknown', `bank: 未知订阅：${subscriptionId}`, {
          subscriptionId,
        })
      }
      // 已取消是终态：再退订不产生新的 CancelRequest，也不把 cancelled 说成 paused
      if (subscription.status === 'cancelled') {
        throw new BahError('subscription-already-cancelled', 'bank: 该订阅已取消，无需重复退订', {
          subscriptionId,
        })
      }
      // 合约期内是硬拦（不是审批）：没有显式确认，连票据都不该签
      if (
        subscription.contractEndAt !== undefined &&
        subscription.contractEndAt > at &&
        confirmContract !== true
      ) {
        throw new BahError(
          'subscription-contract-active',
          `bank: 订阅处于合约期（至 ${new Date(subscription.contractEndAt).toISOString().slice(0, 10)}），需用户显式确认后才能取消`,
          { subscriptionId, contractEndAt: subscription.contractEndAt },
        )
      }

      const merchantKey = normalizeMerchant(subscription.merchantKey ?? subscription.merchant)
      const authorizations = await deps.core.listAuthorizations(userId)
      const path: CancelPath = authorizations.some(
        (item) => item.status === 'active' && item.merchantKey === merchantKey,
      )
        ? 'authorize'
        : SELF_SERVICE_MERCHANTS.has(merchantKey)
          ? 'merchant'
          : 'manual'

      const expectedEffectiveAt =
        mode === 'at-next-cycle'
          ? Math.max(subscription.nextChargeAt, at)
          : path === 'authorize'
            ? at
            : at + (path === 'merchant' ? 5 : 10) * DAY_MS
      const verifyBy = Math.max(expectedEffectiveAt, subscription.nextChargeAt) + 3 * DAY_MS

      const cancelled = await deps.core.cancelSubscription(userId, subscriptionId, mode)
      const request = await deps.core.recordCancelRequest({
        userId,
        subscriptionId,
        path,
        mode,
        requestedAt: at,
        expectedEffectiveAt,
        verifyBy,
      })
      deps.audit.append('sub/cancelled', {
        subscriptionId: cancelled.subscriptionId,
        merchant: cancelled.merchant,
        at,
      })
      return {
        subscriptionId: cancelled.subscriptionId,
        merchant: cancelled.merchant,
        status: cancelled.pausedUntil === undefined ? 'cancelled' : 'paused',
        mode,
        path,
        cancelRequestId: request.id,
        expectedEffectiveAt,
        verifyBy,
        cancelledAt: at,
        ...(subscription.contractEndAt === undefined
          ? {}
          : { contractEndAt: subscription.contractEndAt }),
        ...(cancelled.pausedUntil === undefined ? {} : { pauseUntil: cancelled.pausedUntil }),
      }
    },
    projectContent: (result) => {
      const tail =
        result.mode === 'at-next-cycle'
          ? `已设置「到期即断」：${new Date(result.pauseUntil ?? result.expectedEffectiveAt)
              .toISOString()
              .slice(0, 10)} 起停止扣款（当前状态：已暂停）。`
          : result.path === 'authorize'
            ? '银行侧已关闭该商户的代扣授权，立即生效。'
            : result.path === 'merchant'
              ? '已提交商户侧取消，预计 2–10 天生效。'
              : '已登记取消请求，需人工协助（商户不支持自助取消）。'
      return [{ type: 'text', text: `已处理对「${sanitizeMerchantForPrompt(result.merchant)}」的退订。${tail}` }]
    },
    presentCall: (args) => subscriptionCancelConfirmCard(args, deps.config.ticketTtlSeconds),
  }
}
