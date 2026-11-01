/**
 * 理财工具（施工单 08 §3.9–§3.11）。
 *
 * 合规硬约束：**三个 `wealth.*` 的结果都带 `disclaimerId`**（施工单 08 §0 第 5 条）。
 * 前端必须据此强制渲染风险提示；模型可见文本里也重复一次，避免转述时丢掉。
 *
 * `wealth_purchase` 是红色写操作：票据链与 `transfer_create` 同构（五绑定 + 核销）。
 */

import { BahError } from '@bah/util'

import type { ToolDefinition, ToolExecContext } from '@bah/core'

import type { HoldingId, ProductId, RiskGrade, WealthProduct } from '../core/index.ts'
import { bankIds, checkSuitability, formatYuan, yuanToCents } from '../core/index.ts'
import type { RiskAssessment } from '../core/provider.ts'
import { requireAccount, requireUserId } from './accounts.ts'
import { readNumber, readOptionalString, readString, readStringArray } from './args.ts'
import type {
  RiskAnswerView,
  RiskAssessResult,
  RiskQuestionsResult,
  RiskSubmitResult,
  WealthCompareResult,
  WealthListResult,
  WealthPositionsResult,
  WealthProductView,
  WealthPurchaseResult,
  WealthRedeemResult,
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

/**
 * `risk_assess`（黄档，动作式）：`questions` 取服务端问卷；`submit` 提交用户逐题作答。
 *
 * ## 为什么是动作式而不是拆成两个工具
 *
 * 工具目录有数量上限（`specs.ts` 顶部的 28），而"发卷/交卷"是同一件事的两步；
 * 拆两个工具会逼着治理面给"取问卷"也签一张票。这里用 `action` 区分，并在
 * `tier.ts` 的 `READ_ONLY_ACTIONS` 里把 `questions` 登记为只读动作——
 * 级别判断仍然只在 `tier.ts`，本文件不含任何阈值或级别自判。
 *
 * ## `submit` 为什么先核销票据再落档
 *
 * 票据是"用户批准**这一次提交**"的凭证。若先落档再核销，同一张票就能被反复提交
 * 不同答案去试探等级；若落档失败就退回票据，模型同样可以拿它重试到满意为止。
 * 所以：核销（一次性）→ 落档；落档失败票据作废，用户重新取卷重新确认。
 */
export function createRiskAssessTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, RiskAssessResult> {
  const spec = specOf('risk_assess')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const action = args['action']
      if (action === 'questions') return issueQuestions(deps, userId, ctx.callId)
      if (action === 'submit') return submitAnswers(deps, userId, args, ctx)
      throw new BahError('tool-args-invalid', 'bank-tools: risk_assess.action 必须是 questions 或 submit', {
        action,
      })
    },
    projectContent: (result) =>
      result.action === 'questions'
        ? [
            {
              type: 'text',
              text:
                `风险问卷已下发（${result.questionnaireId}，有效期至 ${new Date(result.expiresAt).toISOString()}）。` +
                `共 ${String(result.questions.length)} 题，请用户本人逐题作答；作答完成后用 action="submit" 提交。`,
            },
          ]
        : [
            {
              type: 'text',
              text:
                `风险测评已落档：${String(result.score)} 分，客户风险等级 ${result.from} → ${result.to}。` +
                `问卷 ${result.questionnaireId}（${result.version}），确认凭证见审计链。`,
            },
          ],
  }
}

/** `action="questions"`：发卷（不写库、不改等级）。 */
async function issueQuestions(
  deps: BankToolDeps,
  userId: string,
  callId: string,
): Promise<RiskQuestionsResult> {
  const questionnaire = await deps.core.issueRiskQuestions(bankIds.user(userId))
  const user = await deps.core.getUser(bankIds.user(userId))
  if (user === undefined) {
    throw new BahError('user-unknown', 'bank-tools: 当前用户不存在', { userId })
  }
  const result: RiskQuestionsResult = {
    action: 'questions',
    questionnaireId: questionnaire.id,
    version: questionnaire.version,
    issuedAt: questionnaire.issuedAt,
    expiresAt: questionnaire.expiresAt,
    questions: questionnaire.questions.map((question) => ({
      index: question.index,
      title: question.title,
      options: question.options.map((option) => ({ ...option })),
    })),
    at: clockOf(deps)(),
  }
  // 题目快照一起落账：回放要能回答"用户当时看到的是哪一版题"。
  deps.audit.append('read/risk-questions', {
    callId,
    questionnaireId: result.questionnaireId,
    version: result.version,
    issuedAt: result.issuedAt,
    expiresAt: result.expiresAt,
    currentGrade: user.riskGrade,
    questions: result.questions,
  })
  return result
}

/** `action="submit"`：核销票据 → 落档 → 记确认凭证。 */
async function submitAnswers(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolExecContext,
): Promise<RiskSubmitResult> {
  const questionnaireId = readString(args, 'questionnaireId', 'risk_assess')
  const answers = parseRiskAnswers(args['answers'])

  // 核销在前：票据一旦被批准就只能用一次（理由见函数上方注释）。
  const ticket = ticketRefForCall(deps, ctx, 'risk_assess', args, 0)
  deps.tickets.redeem(ticket, clockOf(deps)())

  let assessed: RiskAssessment
  try {
    assessed = await deps.core.assessRisk({
      userId: bankIds.user(userId),
      questionnaireId,
      answers,
    })
  } catch (error) {
    throw cooldownErrorOf(error)
  }
  const result: RiskSubmitResult = {
    action: 'submit',
    questionnaireId: assessed.questionnaireId,
    version: assessed.version,
    answers: assessed.answers.map((answer) => ({ ...answer })),
    score: assessed.score,
    from: assessed.from,
    to: assessed.to,
    at: assessed.at,
  }
  deps.audit.append('risk/assessed', {
    result,
    questionnaireId: result.questionnaireId,
    version: result.version,
    confirmedBy: 'approval-ticket',
    ticketRef: String(ticket.ticketId),
    answers: result.answers.map((answer) => ({ ...answer })),
  })
  return result
}

/** 一小时（毫秒；冷却文案换算用）。 */
const HOUR_MS = 3_600_000

/**
 * 冷却错误 → 用户可读文案（R-2 第 4 条）。
 *
 * 只改写 `risk-retest-cooldown` 的 message；其它错误**原样抛出**（不吞错、不改码）。
 * detail 缺字段时保留原错误——宁可用核心的兜底文案，也不编一个"X 小时"出来。
 * 码保持不变：渠道与门禁仍按同一个理由码分支，改的只是给人看的那句话。
 */
function cooldownErrorOf(error: unknown): unknown {
  if (!(error instanceof BahError) || error.code !== 'risk-retest-cooldown') return error
  const detail =
    typeof error.detail === 'object' && error.detail !== null
      ? (error.detail as Record<string, unknown>)
      : {}
  const cooldownMs = detail['cooldownMs']
  const remainingMs = detail['remainingMs']
  if (
    typeof cooldownMs !== 'number' ||
    typeof remainingMs !== 'number' ||
    !Number.isFinite(cooldownMs) ||
    !Number.isFinite(remainingMs) ||
    cooldownMs <= 0
  ) {
    return error
  }
  // 向上取整：冷却 24 小时要说"不足 24 小时"，剩余 23.2 小时要说"请在 24 小时后重试"
  // （说小了会让用户提前重试再被拒一次）。剩余恰好为 0 时也至少写 1 小时。
  const cooldownHours = Math.ceil(cooldownMs / HOUR_MS)
  const remainingHours = Math.max(1, Math.ceil(remainingMs / HOUR_MS))
  return new BahError(
    'risk-retest-cooldown',
    `距上次测评不足 ${String(cooldownHours)} 小时，请在 ${String(remainingHours)} 小时后重试`,
    error.detail,
  )
}

/**
 * 解析 `answers` 参数（5 条 `{index, key}`）。
 *
 * 只做**形状**校验；"题号是否属于这张卷、选项是否属于这道题"由 core 判定——
 * 工具层不复制一份题目表，否则题干一改两处必然漂移。
 */
function parseRiskAnswers(raw: unknown): readonly { readonly index: number; readonly key: string }[] {
  if (!Array.isArray(raw)) {
    throw new BahError('tool-args-invalid', 'bank-tools: risk_assess.answers 必须是数组', {})
  }
  return raw.map((item, position) => {
    if (typeof item !== 'object' || item === null) {
      throw new BahError('tool-args-invalid', 'bank-tools: risk_assess.answers 每项必须是 {index,key}', {
        position,
      })
    }
    const record = item as Readonly<Record<string, unknown>>
    const index = record['index']
    const key = record['key']
    if (typeof index !== 'number' || !Number.isInteger(index)) {
      throw new BahError('tool-args-invalid', 'bank-tools: risk_assess.answers[].index 必须是整数', {
        position,
      })
    }
    if (typeof key !== 'string') {
      throw new BahError('tool-args-invalid', 'bank-tools: risk_assess.answers[].key 必须是字符串', {
        position,
      })
    }
    return { index, key }
  })
}

/** `wealth_positions`（绿档）：持仓与盈亏。 */
export function createWealthPositionsTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, WealthPositionsResult> {
  const spec = specOf('wealth_positions')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (_args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const holdings = await deps.core.listHoldings(bankIds.user(userId))
      const products = await deps.core.listWealthProducts()
      const views = holdings.map((holding) => {
        const product = products.find((item) => item.id === holding.productId)
        return {
          holdingId: holding.id,
          productId: holding.productId,
          productName: product?.name ?? String(holding.productId),
          shares: holding.shares,
          costCents: holding.costCents,
          marketValueCents: holding.marketValueCents,
          profitCents: holding.profitCents,
        }
      })
      const result: WealthPositionsResult = {
        holdings: views,
        totalCostCents: views.reduce((sum, item) => sum + item.costCents, 0),
        totalMarketValueCents: views.reduce((sum, item) => sum + item.marketValueCents, 0),
        totalProfitCents: views.reduce((sum, item) => sum + item.profitCents, 0),
        disclaimerId: deps.config.disclaimerId,
      }
      deps.audit.append('read/wealth-positions', { result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          result.holdings.length === 0
            ? '当前没有理财持仓。'
            : `持仓 ${result.holdings.length} 笔：\n` +
              result.holdings
                .map(
                  (item) =>
                    `- ${item.productName}（${item.holdingId}）：${item.shares} 份，` +
                    `市值 ${formatYuan(item.marketValueCents)}，盈亏 ${formatYuan(item.profitCents)}`,
                )
                .join('\n') +
              `\n合计市值 ${formatYuan(result.totalMarketValueCents)}，盈亏 ${formatYuan(result.totalProfitCents)}。` +
              `\n风险提示：${result.disclaimerId}。`,
      },
    ],
  }
}

/** `wealth_redeem`（红档）：按持仓/产品赎回，缺省全额。 */
export function createWealthRedeemTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, WealthRedeemResult> {
  const spec = specOf('wealth_redeem')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const holdingIdRaw = readOptionalString(args, 'holdingId', spec.name)
      const productIdRaw = readOptionalString(args, 'productId', spec.name)
      if (holdingIdRaw === undefined && productIdRaw === undefined) {
        throw new BahError('tool-args-invalid', 'bank-tools: holdingId 与 productId 至少给一个', {})
      }
      const holdings = await deps.core.listHoldings(bankIds.user(userId))
      const holding = holdings.find(
        (item) =>
          (holdingIdRaw !== undefined && item.id === holdingIdRaw) ||
          (holdingIdRaw === undefined && productIdRaw !== undefined && item.productId === productIdRaw),
      )
      if (holding === undefined) {
        throw new BahError('holding-unknown', 'bank-tools: 找不到可赎回的持仓', {
          holdingId: holdingIdRaw,
          productId: productIdRaw,
        })
      }
      const amountCents =
        args['amountYuan'] === undefined
          ? holding.marketValueCents
          : yuanToCents(readNumber(args, 'amountYuan', spec.name))
      const ticket = ticketRefForCall(deps, ctx, spec.name, args, amountCents)
      const redeemed = await deps.core.redeemWealth(
        {
          userId: bankIds.user(userId),
          holdingId: holding.id as HoldingId,
          amountCents,
        },
        ticket,
      )
      const result: WealthRedeemResult = {
        ...redeemed,
        productId: redeemed.productId as ProductId,
        disclaimerId: deps.config.disclaimerId,
      }
      deps.audit.append('wealth/redeemed', { result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `赎回成功：${result.productName} ${formatYuan(result.amountCents)}（${result.shares} 份），` +
          `流水号 ${result.txnId}，余额 ${formatYuan(result.balanceCents)}。` +
          `\n风险提示：${result.disclaimerId}。`,
      },
    ],
  }
}
