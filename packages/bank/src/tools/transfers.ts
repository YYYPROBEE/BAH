/**
 * 转账工具（施工单 08 §3.7–§3.8）。
 *
 * - `transfer_preview` 绿级只读：试算 + 风控预检，结果里直接给出「执行时会是黄还是红」；
 * - `transfer_create` 黄级写：票据由 pre-execute 的 `ask` 判决签发，执行时在工具边界
 *   组装五绑定引用交给 bank-core 核销；日累计 / 新收款人的升级规则在 `tier.ts`。
 */

import type { ToolDefinition } from '@bah/core'

import type { Account } from '../core/index.ts'
import { formatYuan, yuanToCents } from '../core/index.ts'
import type { TransferPreview } from '../core/provider.ts'
import { requireAccount, requireUserId } from './accounts.ts'
import type { PayeeBinding } from '../core/index.ts'
import type { TransferCreatedResult, TransferPreviewResult } from './dto.ts'
import { parseTransferInput, assertExecutableNow, type TransferInput } from './inputs.ts'
import { transferConfirmCard, transferCreatedCard, transferPreviewCard } from './presenters.ts'
import { specOf } from './specs.ts'
import { decide } from './tier.ts'
import { ticketRefForCall } from './tickets.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** `transfer_preview`（绿级只读）。 */
export function createTransferPreviewTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, TransferPreviewResult> {
  const spec = specOf('transfer_preview')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const account = await requireAccount(deps, userId)
      const input = parseTransferInput(args)
      const result = await previewTransfer(deps, userId, account, input)
      deps.audit.append('transfer/preview', { result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `试算：向 ${result.payeeName}（${bindingLabel(result.payeeBinding)}）转账 ${formatYuan(result.amountCents)}，` +
          `手续费 ${formatYuan(result.feeCents)}。当日已用 ${formatYuan(result.dailyUsedCents)}，` +
          `剩余 ${formatYuan(result.remainingCents)}。风控结论 ${result.verdict}，执行级别「${result.effectiveTier}」。` +
          (result.risks.length === 0 ? '' : `\n提示：${result.risks.map((risk) => risk.message).join('；')}`),
      },
    ],
    presentResult: (_args, result) => transferPreviewCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, TransferPreviewResult>
}

/** `transfer_create`（黄级写）。 */
export function createTransferCreateTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, TransferCreatedResult> {
  const spec = specOf('transfer_create')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const account = await requireAccount(deps, userId)
      const input = parseTransferInput(args)
      assertExecutableNow(input.when, clockOf(deps)())

      const ticket = ticketRefForCall(deps, ctx, spec.name, args, input.amountCents)
      const created = await deps.core.createTransfer(
        {
          fromAccountId: account.id,
          payee: input.payee,
          amountCents: input.amountCents,
          channel: 'app',
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        },
        ticket,
      )
      const result: TransferCreatedResult = {
        txnId: created.txnId,
        ticketId: created.ticketId,
        amountCents: created.amountCents,
        feeCents: created.feeCents,
        payeeName: input.payee.name,
        balanceCents: created.balanceCents,
        availableCents: created.availableCents,
        dailyUsedCents: created.dailyUsedCents,
        dailyLimitCents: created.dailyLimitCents,
        remainingCents: created.remainingCents,
        at: created.at,
      }
      deps.audit.append('transfer/created', { result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `转账成功：${formatYuan(result.amountCents)} → ${result.payeeName}；` +
          `流水号 ${result.txnId}，票据 ${result.ticketId}；余额 ${formatYuan(result.balanceCents)}。`,
      },
    ],
    presentCall: (args) => transferConfirmCard(args, deps.config.ticketTtlSeconds),
    presentResult: (_args, result) => transferCreatedCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, TransferCreatedResult>
}

/**
 * 试算实现（治理平面也调用它做升级判定，保证两处口径一致）。
 *
 * 生效级别以 **transfer_create 的声明下限（黄）** 为基线：
 * 试算卡片的用途就是告诉用户"执行时会发生什么"，按绿级展示会低估确认成本。
 * 生效日限额 = `min(core 账本的卡/账户限额, Config 的 dailyTransferLimit)`（施工单 09 §1.1 第 2 条）。
 */
export async function previewTransfer(
  deps: BankToolDeps,
  userId: string,
  account: Account,
  input: TransferInput,
): Promise<TransferPreviewResult> {
  const preview = await deps.core.previewTransfer({
    fromAccountId: account.id,
    payee: input.payee,
    amountCents: input.amountCents,
    channel: 'app',
  })
  return toTransferPreview(preview, clockOf(deps)(), yuanToCents(deps.config.dailyTransferLimit))
}

/** 预检结果 → DTO（纯函数，`at` 由调用方给，避免读时钟）。 */
export function toTransferPreview(
  preview: TransferPreview,
  at: number,
  dailyLimitCents?: number,
): TransferPreviewResult {
  // 生效日限额与 legacy `escalateTransferTier` 同一口径：只取 min(core, config)。
  const limitCents =
    dailyLimitCents === undefined
      ? preview.dailyLimitCents
      : Math.min(preview.dailyLimitCents, dailyLimitCents)
  // 试算卡片只展示"执行时会是黄还是红"：仍然走 tier.ts 的同一判定矩阵，
  // 但不直接引用 `escalateTransferTier`——策略外置后，legacy 升级规则只允许在
  // `tier.ts` / `policy.ts` 出现（03 §7.3 第 1 条）。这里传 `declared: 'yellow'`
  // 与无风险调用状态，等价于旧的 `escalateTransferTier('yellow', preview, limit)`。
  const tier = decide({
    name: 'transfer_create',
    declared: 'yellow',
    config: {
      dailyTransferLimitCents: limitCents,
      riskyOps: [],
      riskyCallThreshold: Number.MAX_SAFE_INTEGER,
    },
    state: { userId: 'preview', riskyCallsInTurn: 0, verifyLocked: false },
    preview,
  })
  return {
    amountCents: preview.amountCents,
    feeCents: preview.feeCents,
    payeeName: preview.payee.name,
    payeeBinding: preview.payee.binding,
    ...(preview.payee.payeeId === undefined ? {} : { payeeId: preview.payee.payeeId }),
    dailyUsedCents: preview.dailyUsedCents,
    dailyLimitCents: limitCents,
    remainingCents: Math.max(0, limitCents - preview.dailyUsedCents),
    risks: preview.risks.map((risk) => ({
      rule: risk.rule,
      severity: risk.severity,
      code: risk.code,
      message: risk.message,
    })),
    verdict: preview.verdict,
    effectiveTier: tier.level,
    at,
  }
}

/** 收款人绑定文案。 */
function bindingLabel(binding: PayeeBinding): string {
  return binding === 'whitelist' ? '已绑定' : '新收款人'
}
