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

import type {
  AccountId,
  CancelPath,
  CardId,
  CardRestrictionKind,
  CardType,
  SubscriptionId,
  UserId,
} from '../core/index.ts'
import { DAY_MS, formatYuan, isMerchantCategory, MERCHANT_LABEL, yuanToCents } from '../core/index.ts'
import { normalizeMerchant } from '../detect/index.ts'
import { requireUserId } from './accounts.ts'
import {
  readBoolean,
  readEnum,
  readNumber,
  readOptionalString,
  readRequiredEnum,
  readString,
} from './args.ts'
import type { CardIssuedResult, CardLimitsResult, CardRestrictionsResult } from './dto.ts'
import { cardStateCard } from './presenters.ts'
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

/** `card_apply`：黄档写（虚拟卡缺省）。 */
export function createCardApplyTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, CardIssuedResult> {
  const spec = specOf('card_apply')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const type =
        readEnum(args, 'type', spec.name, ['virtual', 'physical'] as const) ?? ('virtual' as CardType)
      /**
       * 卡产品（ADR-0015）：`kind` 与 `creditLimitYuan` 必须**成对**——
       * 信用卡不给额度等于开一张额度未知的卡，借记卡给额度等于把交易限额当授信额度，
       * 两种都是参数错，在工具边界就拒（`tool-args-invalid`），不留给 core 猜。
       */
      const kind = readEnum(args, 'kind', spec.name, ['debit', 'credit'] as const) ?? 'debit'
      const creditLimitCents = readOptionalYuan(args, 'creditLimitYuan', spec.name)
      if (kind === 'credit' && creditLimitCents === undefined) {
        throw new BahError(
          'tool-args-invalid',
          'bank-tools: 申请信用卡必须给 creditLimitYuan（授信额度，元）',
          { kind },
        )
      }
      if (kind === 'debit' && creditLimitCents !== undefined) {
        throw new BahError(
          'tool-args-invalid',
          'bank-tools: 借记卡没有授信额度；要办信用卡请传 kind="credit"（creditLimitYuan 只用于信用卡）',
          { kind, creditLimitYuan: args['creditLimitYuan'] },
        )
      }
      const accountIdArg = readOptionalString(args, 'accountId', spec.name)
      const dailyLimitCents = readOptionalYuan(args, 'dailyLimitYuan', spec.name)
      const monthlyLimitCents = readOptionalYuan(args, 'monthlyLimitYuan', spec.name)
      /**
       * 补发（2026-11-01）：挂失后必须有一条"补一张"的路，否则用户只能拿着废卡等通知。
       *
       * 三条约束：
       * 1. 原卡必须属于本人且**已挂失**（没挂失就补发 = 绕过挂失风控）；
       * 2. 新卡默认挂回原账户（补卡不改账户归属）；
       * 3. 不动旧卡状态：它已经是 `lost` 终态，补发不"复活"它。
       */
      const replacesCardId = readOptionalString(args, 'replacesCardId', spec.name) as
        | CardId
        | undefined
      let accountId = accountIdArg
      if (replacesCardId !== undefined) {
        const cards = await deps.core.listCards(userId)
        const old = cards.find((item) => item.id === replacesCardId)
        if (old === undefined) {
          throw new BahError('card-unknown', `bank: 未知卡片：${replacesCardId}`, {
            cardId: replacesCardId,
          })
        }
        if (old.status !== 'lost') {
          throw new BahError(
            'card-not-lost',
            'bank: 只有已挂失的卡可以补发（其他情况请直接申请新卡）',
            { cardId: replacesCardId, status: old.status },
          )
        }
        accountId = accountIdArg ?? old.accountId
      }
      const issued = await deps.core.applyCard({
        userId,
        ...(accountId === undefined ? {} : { accountId: accountId as AccountId }),
        type,
        ...(kind === 'credit' ? { kind } : {}),
        ...(creditLimitCents === undefined ? {} : { creditLimitCents }),
        ...(dailyLimitCents === undefined ? {} : { dailyLimitCents }),
        ...(monthlyLimitCents === undefined ? {} : { monthlyLimitCents }),
      })
      const at = clockOf(deps)()
      deps.audit.append('card/issued', {
        cardId: issued.cardId,
        accountId: issued.accountId,
        tail: issued.tail,
        type: issued.type,
        dailyLimitCents: issued.dailyLimitCents,
        monthlyLimitCents: issued.monthlyLimitCents,
        // 仅信用产品带这个字段：借记卡的事件形状与 v1.0.3 逐字一致（event-table §3.5）。
        ...(issued.creditLimitCents === undefined
          ? {}
          : { creditLimitCents: issued.creditLimitCents }),
        at,
      })
      return {
        ...issued,
        ...(replacesCardId === undefined ? {} : { replacedCardId: replacesCardId }),
        at,
      }
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `${result.replacedCardId === undefined ? '已申请' : '已补发'}` +
          `${result.type === 'virtual' ? '虚拟' : '实体'}${result.kind === 'credit' ? '信用' : ''}卡：` +
          `尾号 ${result.tail}（卡ID ${result.cardId}），` +
          `日限 ${formatYuan(result.dailyLimitCents)}、月限 ${formatYuan(result.monthlyLimitCents)}。` +
          (result.kind === 'credit' && result.creditLimitCents !== undefined
            ? `授信额度 ${formatYuan(result.creditLimitCents)}、` +
              `已用 ${formatYuan(result.usedCreditCents ?? 0)}、` +
              `可用 ${formatYuan(Math.max(0, result.creditLimitCents - (result.usedCreditCents ?? 0)))}。`
            : '') +
          (result.replacedCardId === undefined
            ? ''
            : `原卡 ${result.replacedCardId} 保持挂失状态，不能恢复使用。`),
      },
    ],
  }
}

/** `card_limit_set`：红档写。 */
export function createCardLimitSetTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, CardLimitsResult> {
  const spec = specOf('card_limit_set')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const cardId = readString(args, 'cardId', spec.name) as CardId
      const dailyLimitCents = readOptionalYuan(args, 'dailyLimitYuan', spec.name)
      const monthlyLimitCents = readOptionalYuan(args, 'monthlyLimitYuan', spec.name)
      const creditLimitCents = readOptionalYuan(args, 'creditLimitYuan', spec.name)
      if (
        dailyLimitCents === undefined &&
        monthlyLimitCents === undefined &&
        creditLimitCents === undefined
      ) {
        throw new BahError('tool-args-invalid', 'bank-tools: 至少给一项额度（日/月/授信）', {})
      }
      const before = (await deps.core.listCards(userId)).find((card) => card.id === cardId)
      if (before === undefined) {
        throw new BahError('card-unknown', `bank: 未知银行卡：${cardId}`, { cardId })
      }
      // 授信额度只有信用产品有；借记卡传了就是参数错（在工具边界说清楚，不交给 core 猜）。
      if (creditLimitCents !== undefined && before.kind !== 'credit') {
        throw new BahError(
          'tool-args-invalid',
          `bank-tools: 尾号 ${before.tail} 的是借记卡，没有授信额度；信用额度请用 card_apply 申请信用卡后再调`,
          { cardId, kind: before.kind ?? 'debit' },
        )
      }
      const changed = await deps.core.setCardLimits(userId, cardId, {
        ...(dailyLimitCents === undefined ? {} : { dailyLimitCents }),
        ...(monthlyLimitCents === undefined ? {} : { monthlyLimitCents }),
        ...(creditLimitCents === undefined ? {} : { creditLimitCents }),
      })
      const at = clockOf(deps)()
      if (changed.changed) {
        deps.audit.append('card/limits-changed', {
          cardId: changed.cardId,
          tail: changed.tail,
          from: {
            dailyLimitCents: before.dailyLimitCents,
            monthlyLimitCents: before.monthlyLimitCents,
          },
          to: {
            dailyLimitCents: changed.dailyLimitCents,
            monthlyLimitCents: changed.monthlyLimitCents,
          },
          // 仅信用产品带这两个字段（event-table §3.5）：借记卡事件形状与 v1.0.3 逐字一致。
          ...(changed.creditLimitCents === undefined
            ? {}
            : {
                creditLimitCents: changed.creditLimitCents,
                usedCreditCents: changed.usedCreditCents ?? 0,
              }),
          at,
        })
      }
      return { ...changed, at }
    },
    projectContent: (result) => {
      const creditText =
        result.kind === 'credit' && result.creditLimitCents !== undefined
          ? `授信额度 ${formatYuan(result.creditLimitCents)}、` +
            `已用 ${formatYuan(result.usedCreditCents ?? 0)}、` +
            `可用 ${formatYuan(Math.max(0, result.creditLimitCents - (result.usedCreditCents ?? 0)))}。`
          : ''
      return [
        {
          type: 'text',
          text: result.changed
            ? `尾号 ${result.tail} 的卡额度已调整：日限 ${formatYuan(result.dailyLimitCents)}、月限 ${formatYuan(result.monthlyLimitCents)}。` +
              creditText
            : `尾号 ${result.tail} 的卡额度未变化。`,
        },
      ]
    },
  }
}

/** `card_restriction`：黄档写（交易限制的 set/clear）。 */
export function createCardRestrictionTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, CardRestrictionsResult> {
  const spec = specOf('card_restriction')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId) as UserId
      const cardId = readString(args, 'cardId', spec.name) as CardId
      const mode = readRequiredEnum(args, 'mode', spec.name, ['set', 'clear'] as const)
      const kind = readEnum(args, 'kind', spec.name, [
        'online',
        'overseas',
        'category',
      ] as const) as CardRestrictionKind | undefined
      const value = readOptionalString(args, 'value', spec.name)
      const note = readOptionalString(args, 'note', spec.name)
      const changed = await deps.core.setCardRestriction(userId, cardId, {
        mode,
        ...(kind === undefined ? {} : { kind }),
        ...(value === undefined ? {} : { value }),
        ...(note === undefined ? {} : { note }),
      })
      const at = clockOf(deps)()
      if (changed.changed) {
        deps.audit.append('card/restrictions-changed', {
          cardId: changed.cardId,
          tail: changed.tail,
          mode,
          restrictions: changed.restrictions.map((restriction) => ({
            kind: restriction.kind,
            ...(restriction.value === undefined ? {} : { value: restriction.value }),
            ...(restriction.note === undefined ? {} : { note: restriction.note }),
            at: restriction.at,
          })),
          at,
        })
      }
      return { cardId: changed.cardId, tail: changed.tail, mode, restrictions: changed.restrictions, changed: changed.changed, at }
    },
    projectContent: (result) => {
      const labels: Readonly<Record<CardRestrictionKind, string>> = {
        online: '线上交易',
        overseas: '境外交易',
        category: '指定品类',
      }
      const list =
        result.restrictions.length === 0
          ? '当前无交易限制'
          : result.restrictions
              .map((item) => {
                if (item.value === undefined) return labels[item.kind]
                const value = isMerchantCategory(item.value)
                  ? MERCHANT_LABEL[item.value]
                  : item.value
                return `${labels[item.kind]}(${value})`
              })
              .join('、')
      return [
        {
          type: 'text',
          text: `尾号 ${result.tail} 的卡交易限制已${result.mode === 'set' ? '更新' : '解除'}：${list}。`,
        },
      ]
    },
  }
}

/** 可选金额（元 → 分）；未给返回 `undefined`，非数字仍 fail-loud。 */
function readOptionalYuan(
  args: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): number | undefined {
  if (args[key] === undefined) return undefined
  return yuanToCents(readNumber(args, key, where))
}
