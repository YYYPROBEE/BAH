/**
 * 理财工具（施工单 08 §3.9–§3.11）。
 *
 * 合规硬约束：**三个 `wealth.*` 的结果都带 `disclaimerId`**（施工单 08 §0 第 5 条）。
 * 前端必须据此强制渲染风险提示；模型可见文本里也重复一次，避免转述时丢掉。
 *
 * `wealth_purchase` 是红色写操作：票据链与 `transfer_create` 同构（五绑定 + 核销）。
 */

import { BahError } from '@bah/util'

import type { ToolDefinition } from '@bah/core'

import type { WealthProduct } from '../core/index.ts'
import { bankIds, formatYuan } from '../core/index.ts'
import { requireAccount, requireUserId } from './accounts.ts'
import { readOptionalString, readString, readStringArray } from './args.ts'
import type {
  WealthCompareResult,
  WealthListResult,
  WealthProductView,
  WealthPurchaseResult,
} from './dto.ts'
import { parseProductId, parsePurchaseAmount, parseWealthFilter } from './inputs.ts'
import { wealthCard, wealthPurchaseConfirmCard, wealthPurchasedCard } from './presenters.ts'
import { specOf } from './specs.ts'
import { ticketRefForCall } from './tickets.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** `wealth_list`（绿级）。 */
export function createWealthListTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, WealthListResult> {
  const spec = specOf('wealth_list')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args) => {
      const filter = parseWealthFilter(args)
      const products = await deps.core.listWealthProducts(filter)
      const result: WealthListResult = {
        products: products.map(toProductView),
        disclaimerId: deps.config.disclaimerId,
        ...(filter === undefined ? {} : { filter }),
      }
      deps.audit.append('read/wealth', { op: 'list', result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `共 ${result.products.length} 个产品：\n` +
          result.products
            .map(
              (product) =>
                `- ${product.name}（${product.productId}）：${product.riskGrade}，${product.termDays} 天，` +
                `预期年化 ${product.expectedYieldPct}%，起投 ${formatYuan(product.minAmountCents)}`,
            )
            .join('\n') +
          `\n风险提示：${result.disclaimerId}（必须向用户展示，理财非存款、投资有风险）`,
      },
    ],
    presentResult: (_args, result) => wealthCard(result, 'list'),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, WealthListResult>
}

/** `wealth_compare`（绿级）。 */
export function createWealthCompareTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, WealthCompareResult> {
  const spec = specOf('wealth_compare')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args) => {
      const ids = readStringArray(args, 'ids', 'wealth_compare')
      if (ids.length < 2 || ids.length > 4) {
        throw new BahError('tool-args-invalid', 'bank-tools: wealth_compare 只接受 2–4 个产品', {
          count: ids.length,
        })
      }
      const products = await deps.core.listWealthProducts()
      const result: WealthCompareResult = {
        products: ids.map((id) => {
          const product = products.find((item) => item.id === parseProductId(id))
          if (product === undefined) {
            throw new BahError('product-unknown', `bank-tools: 未知理财产品 ${id}`, { productId: id })
          }
          return toProductView(product)
        }),
        disclaimerId: deps.config.disclaimerId,
      }
      deps.audit.append('read/wealth', { op: 'compare', result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          result.products
            .map(
              (product) =>
                `- ${product.name}（${product.productId}）：${product.riskGrade}，${product.termDays} 天，` +
                `预期年化 ${product.expectedYieldPct}%，起投 ${formatYuan(product.minAmountCents)}`,
            )
            .join('\n') + `\n风险提示：${result.disclaimerId}（必须向用户展示）`,
      },
    ],
    presentResult: (_args, result) => wealthCard(result, 'compare'),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, WealthCompareResult>
}

/** `wealth_purchase`（红级）。 */
export function createWealthPurchaseTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, WealthPurchaseResult> {
  const spec = specOf('wealth_purchase')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const account = await requireAccount(
        deps,
        userId,
        readOptionalString(args, 'accountId', 'wealth_purchase'),
      )
      const productId = parseProductId(readString(args, 'productId', 'wealth_purchase'))
      const amountCents = parsePurchaseAmount(args)

      const products = await deps.core.listWealthProducts()
      const product = products.find((item) => item.id === productId)
      if (product === undefined) {
        throw new BahError('product-unknown', `bank-tools: 未知理财产品 ${productId}`, {
          productId,
        })
      }

      const ticket = ticketRefForCall(deps, ctx, spec.name, args, amountCents)
      const holding = await deps.core.purchaseWealth(
        { userId: bankIds.user(userId), accountId: account.id, productId, amountCents },
        ticket,
      )
      const result: WealthPurchaseResult = {
        holdingId: holding.id,
        productId,
        productName: product.name,
        amountCents,
        shares: holding.shares,
        disclaimerId: deps.config.disclaimerId,
        at: clockOf(deps)(),
      }
      deps.audit.append('wealth/purchased', { result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `购买成功：${result.productName} ${formatYuan(result.amountCents)}（${result.shares} 份），` +
          `持仓 ${result.holdingId}。风险提示：${result.disclaimerId}。`,
      },
    ],
    presentCall: (args) => wealthPurchaseConfirmCard(args, deps.config.ticketTtlSeconds),
    presentResult: (_args, result) => wealthPurchasedCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, WealthPurchaseResult>
}

/** 产品 → 视图。 */
function toProductView(product: WealthProduct): WealthProductView {
  return {
    productId: product.id,
    name: product.name,
    kind: product.kind,
    termDays: product.termDays,
    expectedYieldPct: product.expectedYieldPct,
    riskGrade: product.riskGrade,
    minAmountCents: product.minAmountCents,
  }
}
