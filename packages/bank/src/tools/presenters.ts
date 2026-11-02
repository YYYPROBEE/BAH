/**
 * 银行工具族的 presenter。
 *
 * 铁律：**纯函数**——同输入同输出；不访问 ctx / 时间 / 随机；不抛错（参数可能来自不可信的模型）。
 * 卡片只描述"展示什么"，渠道（Web / IM / 移动）按 `kind` 选模板，业务逻辑不进渠道。
 *
 * 金额与时间在模板里先格式化成字符串：渠道不需要再知道「分」或 ISO 口径，
 * 也不可能各自算出不同的展示（`formatYuan` 不依赖 locale）。
 */

import type { UiCard } from '@bah/core'

import type {
  AccountsResult,
  AnalysisResult,
  BalanceResult,
  BillAnalysisResult,
  BillReportResult,
  SubscriptionListResult,
  CardView,
  TransferCreatedResult,
  TransferPreviewResult,
  TxnQueryResult,
  VerifyResult,
  WealthCatalogResult,
  WealthPurchaseResult,
} from './dto.ts'
import type {
  AccountStatus,
  ChargeCycle,
  RecurringKind,
  SubscriptionStatus,
  TxnCategory,
} from '../core/model.ts'
import type { CardStateResult } from './account-ops.ts'
import { ACCOUNT_TYPE_LABEL, formatYuan, yuanToCents } from '../core/model.ts'
import { MERCHANT_LABEL } from '../core/merchant.ts'

/**
 * 账户类型文案。真源在 `core/model.ts`（内部划转的命中口径要用同一个函数），
 * 这里只再导出以保持工具族的既有导入面。
 */
export { ACCOUNT_TYPE_LABEL }

/** 账户状态文案。 */
export const ACCOUNT_STATUS_LABEL: Readonly<Record<AccountStatus, string>> = {
  active: '正常',
  frozen: '冻结',
  closed: '销户',
}

/**
 * 账单口径文案（穷尽表：新增口径漏写会编译失败，而不是静默显示成"近三个月"）。
 */
const PERIOD_LABEL: Readonly<Record<'month' | 'quarter' | 'year', string>> = {
  month: '本月',
  quarter: '近三个月',
  year: '近十二个月',
}

/** 商户品类文案（真源在 `core/merchant.ts`；这里再导出以保持工具族的导入面）。 */
export { MERCHANT_LABEL }

/** 卡片类型文案。 */
export const CARD_TYPE_LABEL: Readonly<Record<CardView['type'], string>> = {
  physical: '实体',
  virtual: '虚拟',
}

/** 卡片状态文案。 */
export const CARD_STATUS_LABEL: Readonly<Record<CardView['status'], string>> = {
  normal: '正常',
  frozen: '已冻结',
  lost: '已挂失',
}

/** 交易分类文案。 */
export const CATEGORY_LABEL: Readonly<Record<TxnCategory, string>> = {
  transfer: '转账',
  salary: '工资',
  consumption: '消费',
  subscription: '订阅',
  wealth: '理财',
  fee: '手续费',
  refund: '退款',
}

/** 验证渠道文案。 */
const CHANNEL_LABEL: Readonly<Record<'face' | 'sms' | 'ushield', string>> = {
  face: '人脸识别',
  sms: '短信验证码',
  ushield: 'U 盾',
}

/** 风险等级文案（08 只区分黄/红；绿不必展示）。 */
const TIER_LABEL = { green: '绿', yellow: '黄', red: '红' } as const

/** 金额（分 → `¥1,234.56`）。 */
function money(cents: number): string {
  return formatYuan(cents)
}

/** 时间（UTC；`2026-10-19 10:00`）。 */
function when(at: number): string {
  const iso = new Date(at).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/** 百分比（保留两位，去掉多余的 0）。 */
function percent(value: number): string {
  return `${String(Math.round(value * 100) / 100)}%`
}

/** 账户列表卡片。 */
export function accountsCard(result: AccountsResult): UiCard {
  return {
    kind: 'bank.account-list',
    data: {
      title: '我的账户',
      accounts: result.accounts.map((account) => ({
        accountId: account.accountId,
        tail: account.tail,
        typeLabel: ACCOUNT_TYPE_LABEL[account.type],
        statusLabel: ACCOUNT_STATUS_LABEL[account.status],
        balanceText: money(account.balanceCents),
        availableText: money(account.availableCents),
      })),
      totalAvailableText: money(result.availableTotalCents),
      /**
       * 卡片行（ADR-0015）：信用产品多一段「额度 / 已用 / 可用」。
       *
       * 为什么可用额度在展示层算：它是 `授信 − 已用` 的派生值，落成字段就是第二份会漂移的真相。
       * 借记卡不带 `creditText`（`kind` 缺省的卡与改动前的卡片数据逐字一致）。
       */
      cards: result.cards.map((card) => ({
        cardId: card.cardId,
        tail: card.tail,
        typeLabel: `${CARD_TYPE_LABEL[card.type]}${card.kind === 'credit' ? '信用' : ''}卡`,
        statusLabel: CARD_STATUS_LABEL[card.status],
        limitText: `日限 ${money(card.dailyLimitCents)}`,
        ...(card.kind === 'credit' && card.creditLimitCents !== undefined
          ? {
              creditText:
                `额度 ${money(card.creditLimitCents)} / 已用 ${money(card.usedCreditCents ?? 0)} / ` +
                `可用 ${money(Math.max(0, card.creditLimitCents - (card.usedCreditCents ?? 0)))}`,
            }
          : {}),
      })),
    },
  }
}

/** 余额卡片。 */
export function balanceCard(result: BalanceResult): UiCard {
  return {
    kind: 'bank.balance',
    data: {
      title: '账户余额',
      accountId: result.accountId,
      tail: result.tail,
      balanceText: money(result.balanceCents),
      availableText: money(result.availableCents),
      frozenText: money(result.frozenCents),
      frozenNote:
        result.frozenCents === 0
          ? '无可冻结金额'
          : '差额为理财冻结 / 锁定金额，不可直接使用',
      asOfText: when(result.asOf),
      txnRef: result.txnRef,
    },
  }
}

/** 交易列表卡片。 */
export function txnsCard(result: TxnQueryResult): UiCard {
  return {
    kind: 'bank.txn-list',
    data: {
      title: '交易流水',
      page: result.page,
      hasMore: result.hasMore,
      items: result.items.map((item) => ({
        txnId: item.txnId,
        atText: when(item.at),
        amountText: `${item.direction === 'out' ? '-' : '+'}${money(item.amountCents)}`,
        direction: item.direction,
        counterparty: item.counterpartyName,
        categoryLabel: CATEGORY_LABEL[item.category],
        status: item.status,
      })),
    },
  }
}

/** 账单分析卡片。 */
export function billAnalysisCard(result: BillAnalysisResult): UiCard {
  return {
    kind: 'bank.bill-analysis',
    data: {
      title: '账单分析',
      periodLabel: PERIOD_LABEL[result.period],
      months: result.months,
      totalInText: money(result.totalInCents),
      totalOutText: money(result.totalOutCents),
      momText: result.momChangePct === undefined ? '无上期数据' : percent(result.momChangePct),
      categories: result.byCategory.map((line) => ({
        category: line.category,
        categoryLabel: CATEGORY_LABEL[line.category],
        amountText: money(line.amountCents),
        shareText: percent(line.sharePct),
      })),
      ...(result.byPayee === undefined
        ? {}
        : {
            payees: result.byPayee.map((line) => ({
              payee: line.payee,
              amountText: money(line.amountCents),
              shareText: percent(line.sharePct),
            })),
          }),
      ...(result.byMerchantCategory === undefined
        ? {}
        : {
            merchantCategories: result.byMerchantCategory.map((line) => ({
              category: line.category,
              categoryLabel: MERCHANT_LABEL[line.category],
              amountText: money(line.amountCents),
              shareText: percent(line.sharePct),
            })),
          }),
      anomalies: result.anomalies.map((item) => ({ kind: item.kind, note: item.note })),
    },
  }
}

/** 账单报告卡片（长文本折叠）。 */
export function billReportCard(result: BillReportResult): UiCard {
  return {
    kind: 'bank.bill-report',
    data: {
      title: '账单报告',
      periodLabel: PERIOD_LABEL[result.period],
      format: result.format,
      text: result.text,
      collapsed: true,
    },
  }
}

/** 受限计算卡片。 */
export function analysisCard(result: AnalysisResult): UiCard {
  return {
    kind: 'bank.analysis',
    data: {
      title: '计算结果',
      code: result.code,
      valueText: String(result.value),
      operations: result.operations,
      elapsedMs: result.elapsedMs,
    },
  }
}

/** 转账预演卡片。 */
export function transferPreviewCard(result: TransferPreviewResult): UiCard {
  return {
    kind: 'bank.transfer-preview',
    data: {
      title: '转账预演',
      amountText: money(result.amountCents),
      payeeName: result.payeeName,
      payeeBinding: result.payeeBinding === 'whitelist' ? '已绑定收款人' : '新收款人',
      arrivalText: '实时到账（模拟）',
      feeText: money(result.feeCents),
      dailyUsedText: money(result.dailyUsedCents),
      remainingText: money(result.remainingCents),
      risks: result.risks.map((risk) => ({ code: risk.code, message: risk.message, severity: risk.severity })),
      verdict: result.verdict,
      tier: result.effectiveTier,
      tierLabel: TIER_LABEL[result.effectiveTier],
    },
  }
}

/** 转账成功卡片。 */
export function transferCreatedCard(result: TransferCreatedResult): UiCard {
  return {
    kind: 'bank.transfer-created',
    data: {
      title: '转账已受理',
      ok: true,
      txnId: result.txnId,
      ticketId: result.ticketId,
      amountText: money(result.amountCents),
      payeeName: result.payeeName,
      atText: when(result.at),
      balanceText: money(result.balanceCents),
      remainingText: money(result.remainingCents),
    },
  }
}

/** 理财产品列表 / 对比卡片。 */
export function wealthCard(result: WealthCatalogResult, op: 'list' | 'compare'): UiCard {
  return {
    kind: op === 'list' ? 'bank.wealth-list' : 'bank.wealth-compare',
    data: {
      title: op === 'list' ? '理财产品' : '产品对比',
      disclaimerId: result.disclaimerId,
      customerRisk: result.customerRisk,
      products: result.products.map((product) => ({
        productId: product.productId,
        name: product.name,
        kind: product.kind,
        termDays: product.termDays,
        yieldText: percent(product.expectedYieldPct),
        riskGrade: product.riskGrade,
        minAmountText: money(product.minAmountCents),
        // 卡片字段与 DTO 同名同义：`eligible=false` 的产品仍展示，只是买不了。
        eligible: product.eligible,
        ...(product.suitabilityNote === undefined
          ? {}
          : { suitabilityNote: product.suitabilityNote }),
      })),
    },
  }
}

/** 理财购买成功卡片。 */
export function wealthPurchasedCard(result: WealthPurchaseResult): UiCard {
  return {
    kind: 'bank.wealth-purchased',
    data: {
      title: '理财购买成功',
      ok: true,
      holdingId: result.holdingId,
      productId: result.productId,
      productName: result.productName,
      amountText: money(result.amountCents),
      shares: result.shares,
      disclaimerId: result.disclaimerId,
      customerRisk: result.riskMatch.customerRisk,
      productRisk: result.riskMatch.productRisk,
      atText: when(result.at),
    },
  }
}

/** 卡片状态迁移卡片（冻结/解冻）。 */
export function cardStateCard(result: CardStateResult): UiCard {
  return {
    kind: 'bank.card-state',
    data: {
      title: result.status === 'frozen' ? '卡片已冻结' : '卡片已解冻',
      cardId: result.cardId,
      tail: result.tail,
      status: result.status,
      statusLabel: CARD_STATUS_LABEL[result.status],
      changed: result.changed,
    },
  }
}

/** 强验证结果卡片。 */
export function verifyCard(result: VerifyResult): UiCard {
  return {
    kind: 'bank.verify',
    data: {
      title: '身份验证',
      channel: result.channel,
      channelLabel: CHANNEL_LABEL[result.channel],
      success: result.success,
      attempts: result.attempts,
      remainingAttempts: result.remainingAttempts,
      ...(result.lockedUntil === undefined
        ? {}
        : { lockedUntilText: when(result.lockedUntil), lockedNote: '红色操作已锁定，请稍后再试或联系客服' }),
    },
  }
}

/** 待执行卡片：转账。 */
export function transferConfirmCard(
  args: Readonly<Record<string, unknown>>,
  ticketTtlSeconds: number,
): UiCard {
  const amount = safeAmount(args['amount'])
  const payee = safePayeeName(args['payee'])
  return {
    kind: 'bank.transfer-confirm',
    data: {
      title: '确认转账',
      operation: 'transfer_create',
      amountText: amount === undefined ? '（金额待定）' : money(amount),
      payeeName: payee ?? '（收款人待定）',
      feeText: money(0),
      tier: 'yellow',
      tierLabel: TIER_LABEL.yellow,
      requiresApproval: true,
      ticketTtlText: `${ticketTtlSeconds} 秒`,
      rejectReasonRequired: true,
      note: '将按金额与收款人风险自动升级；红级需强验证',
    },
  }
}

/** 待执行卡片：理财购买。 */
export function wealthPurchaseConfirmCard(
  args: Readonly<Record<string, unknown>>,
  ticketTtlSeconds: number,
): UiCard {
  const amount = safeAmount(args['amount'])
  return {
    kind: 'bank.wealth-confirm',
    data: {
      title: '确认购买理财',
      operation: 'wealth_purchase',
      productId: typeof args['productId'] === 'string' ? args['productId'] : '（产品待定）',
      amountText: amount === undefined ? '（金额待定）' : money(amount),
      tier: 'red',
      tierLabel: TIER_LABEL.red,
      requiresApproval: true,
      ticketTtlText: `${ticketTtlSeconds} 秒`,
      rejectReasonRequired: true,
      note: '红级操作需强验证 + 审批',
    },
  }
}

/** 待执行卡片：退订（黄档；合约期内硬拦的提示必须在卡上）。 */
export function subscriptionCancelConfirmCard(
  args: Readonly<Record<string, unknown>>,
  ticketTtlSeconds: number,
): UiCard {
  const mode = args['mode'] === 'at-next-cycle' ? 'at-next-cycle' : 'now'
  const confirmed = args['confirmContract'] === true
  return {
    kind: 'bank.subscription-cancel-confirm',
    data: {
      title: '确认退订',
      operation: 'sub_cancel',
      subscriptionId:
        typeof args['subscriptionId'] === 'string' ? args['subscriptionId'] : '（订阅待定）',
      mode,
      modeLabel: mode === 'at-next-cycle' ? '到期即断' : '立即取消',
      contractConfirmed: confirmed,
      tier: 'yellow',
      tierLabel: TIER_LABEL.yellow,
      requiresApproval: true,
      ticketTtlText: `${ticketTtlSeconds} 秒`,
      rejectReasonRequired: true,
      note: confirmed
        ? '已确认合约期后果（可能产生违约金）；取消后仍扣款将在核验窗口后标为失败'
        : '若该订阅仍在合约期，会被硬拦并要求显式确认；取消后仍扣款会进入争议工单',
    },
  }
}

/** 待执行卡片：关闭代扣协议（黄档；影响面必须复述）。 */
export function subscriptionAuthorizeConfirmCard(
  args: Readonly<Record<string, unknown>>,
  ticketTtlSeconds: number,
): UiCard {
  return {
    kind: 'bank.subscription-authorize-confirm',
    data: {
      title: '确认关闭代扣协议',
      operation: 'sub_authorize',
      merchant: typeof args['merchant'] === 'string' ? args['merchant'] : '（商户待定）',
      tier: 'yellow',
      tierLabel: TIER_LABEL.yellow,
      requiresApproval: true,
      ticketTtlText: `${ticketTtlSeconds} 秒`,
      rejectReasonRequired: true,
      note:
        '影响该商户的全部订阅（不止一个）；关闭后商户继续扣款会触发 critical 违约警报；' +
        '恢复扣款需在商户侧重新签约，本操作不提供恢复',
    },
  }
}

/** 安全地把「元」转成分（非法输入返回 `undefined`，presenter 不抛错）。 */
function safeAmount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return yuanToCents(value)
}/** 安全地取收款人姓名。 */
function safePayeeName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const name = (value as Record<string, unknown>)['name']
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined
}

/* ── 场景 5：订阅 / 代扣卡片 ─────────────────────────────────────────────── */

export const CYCLE_LABEL: Readonly<Record<ChargeCycle, string>> = {
  weekly: '每周',
  monthly: '每月',
  quarterly: '每季',
}

const KIND_LABEL: Readonly<Record<RecurringKind, string>> = {
  subscription: '订阅',
  bill: '账单',
  installment: '分期',
}

const SUB_STATUS_LABEL: Readonly<Record<SubscriptionStatus, string>> = {
  active: '生效中',
  paused: '已暂停',
  cancelled: '已取消',
}

const CONFIDENCE_LABEL = {
  high: '已确认规律',
  medium: '疑似订阅，确认一下',
  low: '仅统计',
} as const

/**
 * 订阅与自动扣款卡片。
 *
 * 推断与事实在 UI 上分开：`detected` 行带置信度徽章，底部固定一行「基于近 N 天 X 笔流水，生成于 Y」；
 * 断供失败/协议违约进 `alerts`，排在最前。
 */
export function subscriptionsCard(result: SubscriptionListResult): UiCard {
  const split = result.spendSplit
  const alerts = result.cutoffFindings
    .filter((item) => item.verdict === 'failed' || item.verdict === 'breached')
    .map((item) => ({
      level: item.level ?? 'warn',
      merchantKey: item.merchantKey,
      verdict: item.verdict,
      hint: item.hint,
    }))
  const days = Math.max(
    0,
    Math.round((result.basis.to - result.basis.from) / (24 * 60 * 60 * 1000)),
  )
  return {
    kind: 'bank.subscription-list',
    data: {
      title: '订阅与自动扣款',
      alerts,
      split: {
        subscriptionText: `订阅 ${String(split.subscriptionCount)} 项 · 月 ${money(split.subscriptionCents)}`,
        billText: `账单 ${String(split.billCount)} 项 · 月 ${money(split.billCents)}`,
        installmentText: `分期 ${String(split.installmentCount)} 项 · 月 ${money(split.installmentCents)}`,
      },
      confirmed: result.confirmed.map((item) => ({
        subscriptionId: item.subscriptionId,
        merchant: item.merchant,
        cycleLabel: CYCLE_LABEL[item.cycle],
        amountText: money(item.amountCents),
        nextChargeText: when(item.nextChargeAt),
        statusLabel: SUB_STATUS_LABEL[item.status],
        ...(item.note === undefined ? {} : { note: item.note }),
        ...(item.reminderAheadDays === undefined
          ? {}
          : { reminderText: `提前 ${String(item.reminderAheadDays)} 天提醒` }),
        ...(item.contractEndAt === undefined
          ? {}
          : { contractText: `合约至 ${when(item.contractEndAt).slice(0, 10)}` }),
        ...(item.authorizationStatus === undefined
          ? {}
          : { authorizationStatus: item.authorizationStatus }),
      })),
      detected: result.detected.map((item) => ({
        merchantKey: item.merchantKey,
        displayName: item.displayName,
        kindLabel: KIND_LABEL[item.kind],
        cycleLabel: CYCLE_LABEL[item.cycle],
        amountText: money(item.amountCents),
        monthlyText: money(item.monthlyCents),
        nextChargeText: when(item.nextChargeAt),
        confidence: item.confidence,
        confidenceLabel: CONFIDENCE_LABEL[item.confidence],
        count: item.count,
        ...(item.priceHike === undefined
          ? {}
          : {
              priceHikeText: `${money(item.priceHike.fromCents)} → ${money(item.priceHike.toCents)}`,
            }),
        ...(item.trialConverted === undefined ? {} : { trialConverted: item.trialConverted }),
        ...(item.suspectedInstallment === undefined
          ? {}
          : { suspectedInstallment: item.suspectedInstallment }),
      })),
      inferenceNote: `基于近 ${String(days)} 天 ${String(result.basis.txnCount)} 笔流水，生成于 ${when(
        result.detectedAt,
      )}（推断，非账本事实）`,
      detectorVersion: result.detectorVersion,
    },
  }
}
