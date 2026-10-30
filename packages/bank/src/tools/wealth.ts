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

import type { RiskGrade, WealthProduct } from '../core/index.ts'
import { bankIds, checkSuitability, formatYuan } from '../core/index.ts'
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
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const customerRisk = await customerRiskOf(deps, userId)
      const filter = parseWealthFilter(args)
      const products = await deps.core.listWealthProducts(filter)
      const result: WealthListResult = {
        products: products.map((product) => toProductView(product, customerRisk)),
        customerRisk,
        disclaimerId: deps.config.disclaimerId,
        ...(filter === undefined ? {} : { filter }),
      }
      deps.audit.append('read/wealth', { op: 'list', result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        // 首行是「卡片顶部」：渠道卡片只从正文派生（`channels/src/web/cards.ts`），
        // 这里写什么，画面就显示什么。
        text:
          `您的风险承受能力：${result.customerRisk}（演示环境静态画像）\n` +
          `共 ${result.products.length} 个产品：\n` +
          result.products.map(productLine).join('\n') +
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
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const customerRisk = await customerRiskOf(deps, userId)
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
          return toProductView(product, customerRisk)
        }),
        customerRisk,
        disclaimerId: deps.config.disclaimerId,
      }
      deps.audit.append('read/wealth', { op: 'compare', result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        // 对比也带 eligible：否则会出现「列表里不能买、对比里看不出」的缝。
        text:
          result.products.map(productLine).join('\n') +
          `\n风险提示：${result.disclaimerId}（必须向用户展示）`,
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
      const customerRisk = await customerRiskOf(deps, userId)

      const ticket = ticketRefForCall(deps, ctx, spec.name, args, amountCents)
      const holding = await deps.core.purchaseWealth(
        { userId: bankIds.user(userId), accountId: account.id, productId, amountCents },
        ticket,
      )
      const at = clockOf(deps)()
      const result: WealthPurchaseResult = {
        holdingId: holding.id,
        productId,
        productName: product.name,
        amountCents,
        shares: holding.shares,
        disclaimerId: deps.config.disclaimerId,
        at,
        // 轻量匹配留痕：随 `wealth/purchased` 载荷落审计链（没有独立 MatchRecord 实体）。
        riskMatch: { customerRisk, productRisk: product.riskGrade, at },
      }
      deps.audit.append('wealth/purchased', { result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `购买成功：${result.productName} ${formatYuan(result.amountCents)}（${result.shares} 份），` +
          `持仓 ${result.holdingId}。\n` +
          `匹配记录：客户 ${result.riskMatch.customerRisk} ≥ 产品 ${result.riskMatch.productRisk}。` +
          `风险提示：${result.disclaimerId}。`,
      },
    ],
    presentCall: (args) => wealthPurchaseConfirmCard(args, deps.config.ticketTtlSeconds),
    presentResult: (_args, result) => wealthPurchasedCard(result),
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, WealthPurchaseResult>
}

/** 读客户风险承受能力（等级的唯一权威在 core；查无此人 fail-loud）。 */
async function customerRiskOf(deps: BankToolDeps, userId: string): Promise<RiskGrade> {
  const user = await deps.core.getUser(bankIds.user(userId))
  if (user === undefined) {
    throw new BahError('user-unknown', 'bank-tools: 当前用户不存在', { userId })
  }
  return user.riskGrade
}

/** 产品 → 视图（`eligible` 由唯一规则算出，不在这里另写阈值）。 */
function toProductView(product: WealthProduct, customerRisk: RiskGrade): WealthProductView {
  const verdict = checkSuitability({ customerRisk, productRisk: product.riskGrade })
  return {
    productId: product.id,
    name: product.name,
    kind: product.kind,
    termDays: product.termDays,
    expectedYieldPct: product.expectedYieldPct,
    riskGrade: product.riskGrade,
    minAmountCents: product.minAmountCents,
    eligible: verdict.allow,
    ...(verdict.allow ? {} : { suitabilityNote: verdict.reason }),
  }
}

/** 列表 / 对比的一行（不可购买的产品在下一行标注；正文即渠道卡片的内容）。 */
function productLine(product: WealthProductView): string {
  const base =
    `- ${product.name}（${product.productId}）：${product.riskGrade}，${product.termDays} 天，` +
    `预期年化 ${product.expectedYieldPct}%，起投 ${formatYuan(product.minAmountCents)}`
  return product.suitabilityNote === undefined ? base : `${base}\n  【${product.suitabilityNote}】`
}
