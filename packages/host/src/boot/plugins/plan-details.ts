/**
 * 授权窗口的**审批明细**（G8：签票时就把每一笔钱说清楚）。
 *
 * ## 为什么要有这个文件
 *
 * `plan_arm` / `transfer_schedule` / `birthday_plan` 都是"用户看过每一笔之后授权"的工具。
 * 之前审批弹窗只显示工具名与一个总额，商户、报价、到期时刻全藏在执行期——用户批准的是
 * 「一个计划」，不是「一笔笔钱」。本文件把**可展示事实**渲染成 `TicketDetail[]`，
 * 由 `plan.ts` 在 `ask` 判决里随 `TicketDraft.details` 交出去。
 *
 * ## 三条硬约束（改这个文件前先读）
 *
 * 1. **价格只认商户报价**（`offer.priceCents`），不许拿入参 `flowerYuan` / `cakeYuan` 当报价：
 *    两者可能不同，而用户付的是报价。`MERCHANT_OFFERS` 的鲜花 +50 必须让明细跟着变。
 * 2. **纯函数**：不读时钟、不读随机、不访问 ctx。同一份 `ArmFacts` 两次渲染必须逐字相同
 *    （`detailsDigest` 就是它的 sha256，抖一下就变成"明细被篡改"）。
 * 3. **读不到的整条省略**，不写"待确认"占位符（P0 的省略纪律）：
 *    占位符会让"服务端没给"看起来像"服务端给了个模糊值"。
 *
 * ## 与 `detailsDigest` 的关系
 *
 * `detailsDigest` = 明细数组稳定序列化后的 sha256 前 16 位。武装时算一次挂在 `ArmedPlan` 上，
 * 唤醒时用**同样的输入**重算一次：商户涨价、条件被改写、档位被改，摘要就变，
 * 唤醒降级为人工确认（`downgrade:'ask'`）。所以本文件的渲染必须**只依赖 durable 字段**。
 */

import { formatYuan } from '@bah/bank'
import type { AuthorizationTier, WindowCondition } from '@bah/runtime'
import type { TicketDetail } from '@bah/core'
import { canonicalJson, sha256Hex } from '@bah/util'

/** 一条计划腿（节点）的可展示事实；金额取不到时整条省略金额，不编 0。 */
export interface PlanLegFacts {
  readonly nodeId: string
  readonly tool: string
  /** 静态金额（分）；动态 args（`${node.x.y}`）算不出时缺省。 */
  readonly amountCents?: number
  /** 收款人显示名（`transfer_create` 的 `payee.name`）。 */
  readonly payee?: string
}

/** 商户事实（只来自 `merchant_search` / `bank:merchant` 的报价）。 */
export interface OfferFacts {
  readonly offerId: string
  readonly merchantName: string
  /** 报价（分）：**这是用户要付的钱**，不是入参预算。 */
  readonly priceCents: number
}

/**
 * 明细渲染的**唯一**输入。
 *
 * 武装时由 `plan.ts` 从 args 构造，唤醒时从 `ArmedPlan` 构造——两边字段必须一一对应，
 * 否则同一张窗口会算出两个摘要（那是 bug，不是"更安全"）。
 */
export interface ArmFacts {
  readonly title: string
  readonly budgetCents: number
  readonly dueAt: number
  readonly tier: AuthorizationTier
  readonly conditions: readonly WindowCondition[]
  readonly offer?: OfferFacts
  readonly legs: readonly PlanLegFacts[]
}

/** 授权档的中文口径（用户看不到 `standard` / `wide` 这种内部枚举）。 */
const TIER_TEXT: Readonly<Record<AuthorizationTier, string>> = {
  strict: '严格（每次都问）',
  standard: '标准（条件成立才自动执行）',
  wide: '宽松（仅非资金动作）',
}

/** 手机号脱敏：前 3 后 4；位数不足整段遮掉（与渠道侧 `maskPhone` 同规则）。 */
export function maskPhone(phone: string): string {
  const digits = phone.trim()
  if (digits.length < 7) return '****'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/**
 * ISO 时刻 → `2026年11月1日 09:00（UTC）`。
 *
 * 全仓金额与时刻都按 UTC 记账（`fixedClock` / 快照回放），所以这里也写 UTC，
 * 并在文案里**显式标注**——把 UTC 说成北京时间是 8 小时的事故。
 */
export function chineseTimeAt(at: number): string {
  const date = new Date(at)
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth() + 1
  const d = date.getUTCDate()
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${String(y)}年${String(m)}月${String(d)}日 ${hh}:${mm}（UTC）`
}

/** 条件快照 → 一行人话；认不出的条件**不省略**（它是安全约束，必须让用户看见原始形状）。 */
function conditionText(condition: WindowCondition): string {
  switch (condition.kind) {
    case 'balance-at-least':
      return `余额 ≥ ${formatYuan(condition.cents)}`
    case 'amount-within':
      return `单笔金额 ≤ ${formatYuan(condition.cents)}`
    case 'fact-unchanged':
      return `事实 ${condition.factId} 仍为第 ${String(condition.version)} 版`
    case 'plan-not-cancelled':
      return `计划 ${condition.planId} 未被撤销`
    case 'address-unchanged':
      return `地址 ${condition.addressId} 仍为第 ${String(condition.version)} 版`
    default:
      // 封闭联合走到这里说明类型被改过；宁可显示裸 kind，也不静默丢一条安全约束
      return String((condition as { readonly kind?: unknown }).kind ?? 'unknown')
  }
}

/**
 * 渲染一张授权窗口的审批明细（`plan_arm` 的 ask 与唤醒复验共用）。
 *
 * 行序固定：金额 → 商户 → 每条腿 → 到期 → 条件 → 档位。
 * **顺序即契约**（摘要依赖它）；往中间插一行会让所有在途窗口在唤醒时判"明细被改"。
 */
export function renderArmDetails(facts: ArmFacts): readonly TicketDetail[] {
  const details: TicketDetail[] = [
    { label: '预算上限', value: formatYuan(facts.budgetCents), emphasis: 'amount' },
  ]
  if (facts.offer !== undefined) {
    details.push({
      label: '商户报价',
      value: `${facts.offer.merchantName} ${formatYuan(facts.offer.priceCents)}`,
      emphasis: 'amount',
    })
  }
  for (const leg of facts.legs) {
    const money = leg.amountCents === undefined ? leg.tool : `${leg.tool} ${formatYuan(leg.amountCents)}`
    const payee = leg.payee === undefined ? '' : ` → ${leg.payee}`
    details.push({
      label: `节点 ${leg.nodeId}`,
      value: `${money}${payee}`,
      ...(leg.amountCents === undefined ? {} : { emphasis: 'amount' as const }),
    })
  }
  details.push({ label: '窗口到期', value: new Date(facts.dueAt).toISOString(), emphasis: 'date' })
  for (const condition of facts.conditions) {
    details.push({ label: '条件快照', value: conditionText(condition) })
  }
  details.push({ label: '授权档位', value: TIER_TEXT[facts.tier] })
  return details
}

/** 定时转账的「当日已用 / 剩余」（来自 `BANK_TRANSFER_PROBE` 的只读试算）。 */
export interface ScheduleUsage {
  readonly dailyUsedCents: number
  readonly dailyLimitCents: number
  readonly remainingCents: number
}

/** 定时转账的明细事实。 */
export interface ScheduleFacts {
  readonly amountCents: number
  readonly payeeName: string
  /** 已脱敏的手机号（原值不进审批帧）。 */
  readonly payeePhoneMasked?: string
  readonly dueAt: number
  /**
   * 当日额度（可选）。
   *
   * 取不到就**整条省略**——`transfer_schedule` 的审批发生在武装时，那时调度器还没跑、
   * 账本也可能没有身份；写 0 会把"服务端没算"包装成"今天还没花钱"。
   */
  readonly usage?: ScheduleUsage
}

/**
 * 渲染定时转账的审批明细。
 *
 * 行序：金额 → 收款人 →（当日额度）→ 执行时刻（ISO / 中文）。
 * 额度两行只在有 `usage` 时出现；与 `transfer_create` 的「当日已用 / 当日剩余」同口径，
 * 数字来自核心试算（`previewTransfer`），不是入参推算。
 */
export function renderScheduleDetails(facts: ScheduleFacts): readonly TicketDetail[] {
  const details: TicketDetail[] = [
    { label: '转账金额', value: formatYuan(facts.amountCents), emphasis: 'amount' },
    {
      label: '收款人',
      value:
        facts.payeePhoneMasked === undefined
          ? facts.payeeName
          : `${facts.payeeName}（${facts.payeePhoneMasked}）`,
    },
  ]
  if (facts.usage !== undefined) {
    details.push(
      { label: '当日已用', value: formatYuan(facts.usage.dailyUsedCents), emphasis: 'amount' },
      { label: '当日剩余', value: formatYuan(facts.usage.remainingCents), emphasis: 'amount' },
    )
  }
  details.push(
    { label: '执行时刻', value: new Date(facts.dueAt).toISOString(), emphasis: 'date' },
    { label: '执行时刻', value: chineseTimeAt(facts.dueAt), emphasis: 'date' },
  )
  return details
}

/** 生日计划的明细事实（三腿 + 窗口）。 */
export interface BirthdayFacts {
  readonly birthdayAt: number
  readonly dueAt: number
  readonly lockCents: number
  /** 鲜花腿：**必须**是商户报价；没有商户服务时缺省（整条腿用入参预算，并标注"无报价"）。 */
  readonly flower?: OfferFacts
  readonly cake?: OfferFacts
  /** 商户服务缺席时退回的入参预算（分）；有报价时不用它。 */
  readonly flowerBudgetCents?: number
  readonly cakeBudgetCents?: number
  readonly totalCents: number
  readonly conditions: readonly WindowCondition[]
  readonly tier: AuthorizationTier
  /**
   * 锁定预算那笔的收款人显示名（本人锁定账户，如 `锁定账户(9012)`）。
   *
   * 取的是**计划节点里的 payee.name**（`plan.ts` 的 `LOCK_ACCOUNT_PAYEE`），
   * 不是这里再写一遍尾号：同一句事实只能有一个来源。
   */
  readonly lockPayee?: string
}

/**
 * 渲染生日计划的审批明细：三笔钱逐笔可。
 *
 * 鲜花 / 蛋糕的金额**只认 `priceCents`**；只有在商户服务缺席（离线 profile）时才退回
 * 入参预算并显式标注「无商户报价」——那是降级事实，不是报价。
 */
export function renderBirthdayDetails(facts: BirthdayFacts): readonly TicketDetail[] {
  const dueText = new Date(facts.dueAt).toISOString()
  const lockValue =
    facts.lockPayee === undefined
      ? formatYuan(facts.lockCents)
      : `${formatYuan(facts.lockCents)} → ${facts.lockPayee}`
  const details: TicketDetail[] = [
    { label: '锁定预算', value: lockValue, emphasis: 'amount' },
  ]

  const leg = (label: string, offer: OfferFacts | undefined, budgetCents: number | undefined): void => {
    if (offer !== undefined) {
      details.push({
        label,
        value: `${formatYuan(offer.priceCents)}（${offer.merchantName}，生日前 2 天 09:00 UTC）`,
        emphasis: 'amount',
      })
      return
    }
    if (budgetCents !== undefined) {
      details.push({
        label,
        value: `${formatYuan(budgetCents)}（无商户报价：商户服务未装配，按入参预算）`,
        emphasis: 'amount',
      })
    }
  }
  leg('鲜花', facts.flower, facts.flowerBudgetCents)
  leg('蛋糕', facts.cake, facts.cakeBudgetCents)

  details.push({ label: '总预算', value: formatYuan(facts.totalCents), emphasis: 'amount' })
  details.push({ label: '窗口到期', value: dueText, emphasis: 'date' })
  for (const condition of facts.conditions) {
    details.push({ label: '条件快照', value: conditionText(condition) })
  }
  details.push({ label: '授权档位', value: TIER_TEXT[facts.tier] })
  return details
}

/**
 * 明细摘要：稳定序列化 → sha256 → 前 16 位。
 *
 * `canonicalJson` 保证键序与空白不影响结果（明细是"同一份数据"，不是"同一段文本"）。
 * 16 位十六进制 = 64 bit：它防的是"悄悄换掉明细"，不是抗碰撞攻击——
 * 真正的防线是唤醒降级为人工确认，摘要只是触发器。
 */
export function detailsDigestOf(details: readonly TicketDetail[]): string {
  return sha256Hex(canonicalJson(details)).slice(0, 16)
}
