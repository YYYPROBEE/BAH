/**
 * 资产处置类工具（W03 §1.3 的两个新工具）。
 *
 * - `card_report_lost`（**红档**）：挂失银行卡。不可逆的资产处置，必须审批 +
 *   红级挑战链；档位在 `spec.tier` 里声明，工具内**不许**自带阈值。
 * - `sub_cancel`（**黄档**）：取消自动扣款订阅。授权撤销可逆，仍需一次审批。
 *
 * 两个工具都只做三件事：校验身份 → 调 core 的写入口 → 落领域事件。
 * **不自己改数据结构**：cards / subscriptions 的属主是 `MockBankCore`，
 * 工具层越过去改数组会绕开"写操作必须经 core"的既有纪律。
 */

import type { ToolDefinition } from '@bah/core'

import type { CardId, SubscriptionId, UserId } from '../core/index.ts'
import { requireUserId } from './accounts.ts'
import { readOptionalString, readString } from './args.ts'
import { cardStateCard } from './presenters.ts'
import { specOf } from './specs.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** `card_report_lost` 的结果。 */
export interface CardReportedLostResult {
  readonly cardId: string
  readonly tail: string
  readonly status: 'lost'
  readonly reportedAt: number
}

/** 冻结/解冻共用的结果（ADR-0006）。 */
export interface CardStateResult {
  readonly cardId: string
  readonly tail: string
  readonly status: 'frozen' | 'normal'
  /** 是否真的发生了迁移（幂等调用为 false）。 */
  readonly changed: boolean
  readonly at: number
}

/** `sub_cancel` 的结果。 */
export interface SubscriptionCancelledResult {
  readonly subscriptionId: string
  readonly merchant: string
  readonly status: 'cancelled'
  readonly cancelledAt: number
}

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

/** `sub_cancel`：黄档写。 */
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
      const cancelled = await deps.core.cancelSubscription(userId, subscriptionId)
      const at = clockOf(deps)()
      deps.audit.append('sub/cancelled', {
        subscriptionId: cancelled.subscriptionId,
        merchant: cancelled.merchant,
        at,
      })
      return {
        subscriptionId: cancelled.subscriptionId,
        merchant: cancelled.merchant,
        status: 'cancelled',
        cancelledAt: at,
      }
    },
    projectContent: (result) => [
      { type: 'text', text: `已取消对「${result.merchant}」的自动扣款订阅。` },
    ],
  }
}

/** 冻结/解冻共用实现（ADR-0006）。 */
function cardStateTool(
  kind: 'freeze' | 'unfreeze',
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, CardStateResult> {
  const name = kind === 'freeze' ? 'card_freeze' : 'card_unfreeze'
  const spec = specOf(name)
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const cardId = readString(args, 'cardId', spec.name) as CardId
      const note = readOptionalString(args, 'reason', spec.name)
      const changed =
        kind === 'freeze'
          ? await deps.core.freezeCard(userId, cardId)
          : await deps.core.unfreezeCard(userId, cardId)
      const at = clockOf(deps)()
      // 幂等调用不落状态迁移事件：重复点击的事实由 tool/result 记录，
      // 不该污染 card/state-changed 的 from→to 链。
      if (changed.changed) {
        deps.audit.append('card/state-changed', {
          cardId: changed.cardId,
          tail: changed.tail,
          from: kind === 'freeze' ? 'normal' : 'frozen',
          to: kind === 'freeze' ? 'frozen' : 'normal',
          reason: kind,
          ...(note === undefined ? {} : { note }),
          at,
        })
      }
      const result: CardStateResult = Object.assign({}, changed, { at })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          result.status === 'frozen'
            ? `尾号 ${result.tail} 的卡已冻结${result.changed ? '' : '（此前已是冻结状态）'}，该卡不能用于支付，可随时解冻。`
            : `尾号 ${result.tail} 的卡已解冻${result.changed ? '' : '（此前已是正常状态）'}，可恢复使用。`,
      },
    ],
    presentResult: (_args, result) => cardStateCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, CardStateResult>
}

/** `card_freeze`：黄档写。 */
export function createCardFreezeTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, CardStateResult> {
  return cardStateTool('freeze', deps)
}

/** `card_unfreeze`：红档写。 */
export function createCardUnfreezeTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, CardStateResult> {
  return cardStateTool('unfreeze', deps)
}
