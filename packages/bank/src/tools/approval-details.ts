/**
 * 审批明细（服务端签发的「即将执行什么」，`TicketDraft.details` 的唯一构造点）。
 *
 * ## 为什么要有这一层
 *
 * 审批卡原先只显示六要素，金额/收款人是渠道从**工具入参**里猜出来的
 * （`channels/web/project.ts` 的 `amountFromArgs` / `payeeFromArgs`）：
 * 只有"参数里恰好有 amount"的工具才显示内容，卡片冻结、订阅取消这类操作永远是空的。
 * 更要紧的是——参数是模型写的，拿参数当"要执行的事实"等于让被审对象自己写判决书。
 *
 * 这里改成：**明细的一切数字都从 `deps.core` 现读**（余额、当日已用、持仓市值、
 * 卡片限额、订阅下一扣费日…），参数只用于"定位实体"与"复述本次意图"。
 *
 * ## 四条硬纪律
 *
 * 1. **只展示**：明细不参与 fingerprint、不参与票据绑定、不参与任何判定
 *    （`TicketDetail` 的注释是权威口径）。它变了，票据不该失效。
 * 2. **读不到就整条省略**：core 抛错 / 实体不存在 / 字段缺省 ⇒ 该行不出现。
 *    绝不填 `—`、`未知`、`0` 之类的占位——占位在审批卡上等同于事实。
 * 3. **不许抛错**：审批卡缺一行是降级，审批链自己炸掉是事故。所有读取都过 `read()`
 *    包裹；参数读取用本文件的安全读取（不复用会抛 `BahError` 的 `readNumber` 等），
 *    因为这里的目标是"能显示多少显示多少"，不是"校验参数"。
 * 4. **PII**：手机号一律前 3 后 4（`maskPhoneNumber`，与渠道 `maskPhone` 同口径）；
 *    AA 参与人手机号**完全不进明细**（群收款里报手机号不是必需信息）。
 *
 * ## 唯一允许来自参数的数字：本次"意图值"
 *
 * 新限额（`card_limit_set` 的 `dailyLimitYuan`）、AA 总额、理财申购金额、赎回金额，
 * 这些在 core 里**还没有实体**（执行后才产生），权威来源就是用户这次请求。
 * 它们一律带"本次"前缀标注，且与"现值"分行显示，避免把意图读成现状。
 */

import type { TicketDetail } from '@bah/core'

import type {
  AaGroupId,
  Card,
  CardRestrictionKind,
  Subscription,
  TransferPreview,
} from '../core/index.ts'
import { bankIds, checkSuitability, formatYuan, isMerchantCategory, MERCHANT_LABEL, riskGradeOfScore, yuanToCents } from '../core/index.ts'
import { normalizeMerchant } from '../detect/merchant.ts'
import { PASSWORD_HANDOFF_PATH, PASSWORD_HANDOFF_TTL_SECONDS } from '../core/password.ts'
import { equalShares } from './aa.ts'
import { requireAccount } from './accounts.ts'
import { parsePurchaseAmount, parseTransferInput } from './inputs.ts'
import type { BankToolSpec } from './specs.ts'
import type { BankToolDeps } from './types.ts'

/** 明细构造的可选输入（`preview` 是治理面已经算过的那份 core 试算结果）。 */
export interface ApprovalDetailsExtras {
  /**
   * 转账试算结果（core 现读）。治理面在签票前已经算过一次，这里直接复用，
   * 避免同一笔转账在审批链上读两遍账本、也可能读出两个值。
   */
  readonly preview?: TransferPreview
}

/* ── 文案表（只做枚举 → 人话，不含任何数字） ─────────────────────────────── */

const CARD_TYPE_LABEL: Readonly<Record<Card['type'], string>> = {
  virtual: '虚拟卡',
  physical: '实体卡',
}

const CARD_STATUS_LABEL: Readonly<Record<Card['status'], string>> = {
  normal: '正常',
  frozen: '已冻结',
  lost: '已挂失',
}

const RESTRICTION_LABEL: Readonly<Record<CardRestrictionKind, string>> = {
  online: '线上交易',
  overseas: '境外交易',
  category: '指定品类',
}

const CYCLE_LABEL: Readonly<Record<Subscription['cycle'], string>> = {
  weekly: '每周',
  monthly: '每月',
  quarterly: '每季度',
}

const WATCH_LABEL: Readonly<Record<'remind' | 'idle' | 'none', string>> = {
  remind: '到期提醒',
  idle: '标记为闲置',
  none: '清除标记',
}

const CANCEL_MODE_LABEL: Readonly<Record<'now' | 'at-next-cycle', string>> = {
  now: '立即取消',
  'at-next-cycle': '到期即断（本周期仍会扣款）',
}

/* ── 安全读取 ─────────────────────────────────────────────────────────────── */

/** 读字符串参数（不抛错；空白/非字符串一律 `undefined`）。 */
function argStr(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 读数字参数（不抛错；非有限数一律 `undefined`）。 */
function argNum(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 读枚举参数（大小写不敏感；不在闭集里一律 `undefined`）。 */
function argEnum<T extends string>(
  args: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const raw = argStr(args, key)?.toLowerCase()
  if (raw === undefined) return undefined
  return allowed.find((item) => item === raw)
}

/** 一次 core 读取（失败 → `undefined`，调用方据此省略整行）。 */
async function read<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch {
    return undefined
  }
}

/** 控制字符与换行折成空格并截断（明细是单行文本，不能靠换行伪造结构）。 */
function textOf(value: string | undefined, max = 80): string | undefined {
  if (value === undefined) return undefined
  // 控制字符（含 CR/LF）折成空格：一个"看起来像换了几行"的附言能伪造出假的字段行
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return undefined
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

/** 账号 / 卡号尾号（非数字串按长度兜底取末 4 位）。 */
function tailOf(value: string): string {
  const digits = value.replace(/\s+/g, '')
  return digits.slice(-4)
}

/**
 * 手机号脱敏：保留前 3 位与后 4 位。
 *
 * 与 `channels/web/amount.ts` 的 `maskPhone` 同口径（那边是渠道侧入参脱敏，
 * 这里是服务端签发面）；位数不足整段遮掉——短号码没有安全的保留阈值。
 */
export function maskPhoneNumber(phone: string): string {
  const digits = phone.trim()
  if (digits.length < 7) return '****'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/** 时刻 → `YYYY-MM-DD`（UTC；与 `governance.subscriptionContractBlock` 同口径）。 */
function dateText(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** 组装行（`undefined` 直接丢弃；空值不占位）。 */
function rowsOf(items: readonly (TicketDetail | undefined)[]): TicketDetail[] {
  return items.filter((item): item is TicketDetail => item !== undefined)
}

/** 一行（`label` / `value` 任一为空则不产出行）。 */
function row(
  label: string,
  value: string | undefined,
  emphasis?: TicketDetail['emphasis'],
): TicketDetail | undefined {
  const text = textOf(value)
  if (text === undefined) return undefined
  return { label, value: text, ...(emphasis === undefined ? {} : { emphasis }) }
}

/** 金额行。 */
function money(
  label: string,
  cents: number | undefined,
  emphasis: TicketDetail['emphasis'] = 'amount',
): TicketDetail | undefined {
  if (cents === undefined || !Number.isFinite(cents)) return undefined
  return row(label, formatYuan(cents), emphasis)
}

/* ── 入口 ─────────────────────────────────────────────────────────────────── */

/**
 * 按工具名构造审批明细。
 *
 * @returns 空数组 = 该工具还没有明细（渠道退回六要素），**不是错误**
 */
export async function detailsForCall(
  deps: BankToolDeps,
  userId: string,
  spec: BankToolSpec,
  args: Readonly<Record<string, unknown>>,
  extras: ApprovalDetailsExtras = {},
): Promise<readonly TicketDetail[]> {
  try {
    switch (spec.name) {
      case 'transfer_create':
      case 'transfer_preview':
        return await transferDetails(deps, userId, args, extras.preview)
      case 'wealth_purchase':
        return await purchaseDetails(deps, userId, args)
      case 'wealth_redeem':
        return await redeemDetails(deps, userId, args)
      case 'risk_assess':
        return await riskAssessDetails(deps, userId, args)
      case 'card_apply':
        return await cardApplyDetails(deps, userId, args)
      case 'card_limit_set':
        return await cardLimitDetails(deps, userId, args)
      case 'card_restriction':
        return await cardRestrictionDetails(deps, userId, args)
      case 'card_freeze':
      case 'card_unfreeze':
      case 'card_report_lost':
        return await cardStateDetails(deps, userId, spec.name, args)
      case 'sub_cancel':
        return await subCancelDetails(deps, userId, args)
      case 'sub_watch':
        return await subWatchDetails(deps, userId, args)
      case 'sub_authorize':
        return await subAuthorizeDetails(deps, userId, args)
      case 'aa_create':
        return await aaDetails(deps, userId, args)
      case 'password_change':
        return passwordDetails(args)
      default:
        // 读操作 / 强验证 / 计划类工具：没有"即将改变什么"可复述
        return []
    }
  } catch {
    // 明细是展示面：任何意外都退化成"没有明细"，绝不让审批链失败
    return []
  }
}

/* ── 转账 ─────────────────────────────────────────────────────────────────── */

/** 用 core 现读一次试算（治理面已算过就直接用 `extras.preview`）。 */
async function previewOf(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<TransferPreview | undefined> {
  return read(async () => {
    const input = parseTransferInput(args)
    const account = await requireAccount(deps, userId)
    return deps.core.previewTransfer({
      fromAccountId: account.id,
      payee: input.payee,
      amountCents: input.amountCents,
      channel: 'app',
      ...(input.viaCardId === undefined ? {} : { viaCardId: input.viaCardId }),
    })
  })
}

/**
 * 转账明细：金额 / 收款人（脱敏手机）/ 支付卡 / 当日已用 / 当日剩余 / 手续费 / 附言。
 *
 * 金额与额度全部来自 `previewTransfer`——**没有试算结果就整组省略**：
 * 不拿参数里的 `amount` 兜底，否则"待确认的数字"会被包装成"服务端算过的事实"。
 */
async function transferDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
  given: TransferPreview | undefined,
): Promise<readonly TicketDetail[]> {
  const preview = given ?? (await previewOf(deps, userId, args))
  if (preview === undefined) return []
  const phone = preview.payee.phone === undefined ? undefined : maskPhoneNumber(preview.payee.phone)
  return rowsOf([
    money('金额', preview.amountCents),
    row('收款人', phone === undefined ? preview.payee.name : `${preview.payee.name}（${phone}）`),
    row(
      '支付卡',
      preview.viaCard === undefined
        ? undefined
        : `尾号 ${preview.viaCard.tail}（${CARD_STATUS_LABEL[preview.viaCard.status]}）`,
    ),
    money('当日已用', preview.dailyUsedCents),
    money('当日剩余', preview.remainingCents),
    money('手续费', preview.feeCents),
    row('附言', argStr(args, 'remark')),
  ])
}

/* ── 理财申购 ─────────────────────────────────────────────────────────────── */

/**
 * 申购明细：产品 / 风险等级 / 期限 / 起投 / 金额 / 适当性结论。
 *
 * 适当性一对数字（客户 ↔ 产品）由 `checkSuitability` 的同一份规则解释，
 * 不在渠道里另写一套"能不能买"的判断。
 */
async function purchaseDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const amountCents = read(async () => parsePurchaseAmount(args))
  const productId = argStr(args, 'productId')
  const products = productId === undefined ? undefined : await read(() => deps.core.listWealthProducts())
  const product = products?.find((item) => item.id === productId)
  const user = await read(() => deps.core.getUser(bankIds.user(userId)))

  const suitability =
    product === undefined || user === undefined
      ? undefined
      : (() => {
          const verdict = checkSuitability({
            customerRisk: user.riskGrade,
            productRisk: product.riskGrade,
          })
          const pair = `${user.riskGrade} ↔ ${product.riskGrade}`
          return verdict.allow ? `${pair} 匹配` : `${pair} 不匹配`
        })()

  return rowsOf([
    row('产品', product?.name),
    row('产品风险等级', product?.riskGrade, 'risk'),
    row('期限', product === undefined ? undefined : `${String(product.termDays)} 天`),
    money('起投金额', product?.minAmountCents),
    money('本次申购', await amountCents),
    row('适当性', suitability, 'risk'),
  ])
}

/* ── 理财赎回 ─────────────────────────────────────────────────────────────── */

/**
 * 赎回明细：持仓产品 / 份额 / 持仓市值 / 本次赎回 / 持仓成本 / 当前收益 / 入账账户。
 *
 * "预计到账本金/收益"用 core 的**持仓成本与当前收益**表达：核心没有"按份额摊成本"
 * 的口径，自己按比例除一次就是第二份算法。缺就只给市值与赎回额。
 */
async function redeemDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const holdingId = argStr(args, 'holdingId')
  const productId = argStr(args, 'productId')
  if (holdingId === undefined && productId === undefined) return []
  const holdings = await read(() => deps.core.listHoldings(bankIds.user(userId)))
  const holding = holdings?.find(
    (item) =>
      (holdingId !== undefined && item.id === holdingId) ||
      (holdingId === undefined && productId !== undefined && item.productId === productId),
  )
  if (holding === undefined) return []

  const products = await read(() => deps.core.listWealthProducts())
  const product = products?.find((item) => item.id === holding.productId)
  const accounts = await read(() => deps.core.listAccounts(bankIds.user(userId)))
  const account =
    accounts?.find((item) => item.id === holding.accountId) ??
    accounts?.find((item) => item.type === 'current')
  const amountYuan = argNum(args, 'amountYuan')
  const redeemCents = amountYuan === undefined ? holding.marketValueCents : yuanToCents(amountYuan)

  return rowsOf([
    row('持仓产品', product?.name),
    row('持有份额', `${holding.shares.toFixed(2)} 份`),
    money('持仓市值', holding.marketValueCents),
    money('本次赎回', redeemCents),
    money('持仓成本', holding.costCents),
    money('当前收益', holding.profitCents),
    row('入账账户', account === undefined ? undefined : `${account.type === 'current' ? '活期' : account.type}账户(${tailOf(account.number)})`),
  ])
}

/* ── 风险测评 ─────────────────────────────────────────────────────────────── */

/**
 * 风险测评明细：五题「题干 → 所选项」 + 得分 + 等级变更。
 *
 * 题干与选项文案**只来自服务端问卷**（`core.getRiskQuestionnaire`，`risk-questionnaire.ts`
 * 的常量表）：模型只回传 `{ index, key }`，它既不知道题干也不知道分值。
 * 审批卡显示的就是"用户被问了什么、选了什么"——这才是 C-03 那条合规缺口的正面修复。
 *
 * 得分只做一次求和（分值来自 `option.score`，不是本文件另写的权重）；
 * 分段映射走 `riskGradeOfScore`（与落档同一个函数）。
 * 问卷取不到（ID 错 / 已被核销）⇒ 整组省略，不猜答案。
 */
async function riskAssessDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const action = argEnum(args, 'action', ['questions', 'submit'] as const)
  if (action !== 'submit') return []
  const questionnaireId = argStr(args, 'questionnaireId')
  if (questionnaireId === undefined) return []
  const questionnaire = await read(() => deps.core.getRiskQuestionnaire(questionnaireId))
  if (questionnaire === undefined) return []
  // 归属校验：`getRiskQuestionnaire` 按设计不按会话过滤（核心在 `assess` 才判归属），
  // 但审批卡不该把「别人的问卷」渲染给当前用户看——宁可没有明细。
  // 题干是全局常量、不算泄密，但"这张卷是别人领的"本身就不该出现在本会话的证据里。
  if (String(questionnaire.userId) !== String(bankIds.user(userId))) return []

  const raw = args['answers']
  if (!Array.isArray(raw)) return []
  const chosen = new Map<number, { readonly text: string; readonly score: number }>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Readonly<Record<string, unknown>>
    const index = record['index']
    const key = record['key']
    if (typeof index !== 'number' || !Number.isInteger(index) || typeof key !== 'string') return []
    const question = questionnaire.questions.find((entry) => entry.index === index)
    const option = question?.options.find((entry) => entry.key === key)
    if (option === undefined) return []
    chosen.set(index, { text: option.text, score: option.score })
  }
  // 五题必须齐全：缺一题的明细等于给用户看一份不完整的确认书
  if (chosen.size !== questionnaire.questions.length) return []

  let score = 0
  const questionRows: (TicketDetail | undefined)[] = []
  for (const question of questionnaire.questions) {
    const picked = chosen.get(question.index)
    if (picked === undefined) return []
    score += picked.score
    questionRows.push(row(question.title, `${picked.text}（${String(picked.score)} 分）`))
  }

  const user = await read(() => deps.core.getUser(bankIds.user(userId)))
  const to = riskGradeOfScore(score)
  return rowsOf([
    ...questionRows,
    row('得分', `${String(score)} 分`),
    row('等级变更（批准后生效）', user === undefined ? to : `${user.riskGrade} → ${to}`, 'risk'),
  ])
}

/* ── 卡片申请 / 限额 / 限制 / 状态 ─────────────────────────────────────────── */

/** 按 `cardId` 从 core 取卡（找不到返回 `undefined`）。 */
async function cardOf(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Card | undefined> {
  const cardId = argStr(args, 'cardId')
  if (cardId === undefined) return undefined
  const cards = await read(() => deps.core.listCards(bankIds.user(userId)))
  return cards?.find((item) => item.id === cardId)
}

/**
 * 新卡申请：卡类型 / 挂靠账户 /（可选）本次申请限额。
 *
 * 尾号与现额在"尚未存在"的实体上读不到，**不预生成尾号**——那会变成批准前后两个数。
 */
async function cardApplyDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const type = argEnum(args, 'type', ['virtual', 'physical'] as const) ?? 'virtual'
  const kind = argEnum(args, 'kind', ['debit', 'credit'] as const) ?? 'debit'
  const accountId = argStr(args, 'accountId')
  const account = await read(() => requireAccount(deps, userId, accountId))
  const daily = argNum(args, 'dailyLimitYuan')
  const monthly = argNum(args, 'monthlyLimitYuan')
  const credit = argNum(args, 'creditLimitYuan')

  return rowsOf([
    row(
      '卡类型',
      // 借记卡沿用原文案（不改既有快照）；信用卡把介质与产品拼在一行（"虚拟信用卡"）。
      kind === 'credit' ? `${type === 'virtual' ? '虚拟' : '实体'}信用卡` : CARD_TYPE_LABEL[type],
    ),
    row(
      '挂靠账户',
      account === undefined ? undefined : `${account.type === 'current' ? '活期' : account.type}账户(${tailOf(account.number)})`,
    ),
    credit === undefined ? undefined : money('本次申请授信额度', yuanToCents(credit)),
    daily === undefined ? undefined : money('本次申请日限', yuanToCents(daily)),
    monthly === undefined ? undefined : money('本次申请月限', yuanToCents(monthly)),
  ])
}

/** 限额调整：卡尾号 / 当前日限 / 当前月限 /（信用产品）当前授信与已用 / 本次调整值（现值与意图分行）。 */
async function cardLimitDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const card = await cardOf(deps, userId, args)
  if (card === undefined) return []
  const daily = argNum(args, 'dailyLimitYuan')
  const monthly = argNum(args, 'monthlyLimitYuan')
  const credit = argNum(args, 'creditLimitYuan')
  const isCredit = card.kind === 'credit'
  return rowsOf([
    row('卡片', `尾号 ${card.tail}（${CARD_STATUS_LABEL[card.status]}${isCredit ? '，信用卡' : ''}）`),
    money('当前日限', card.dailyLimitCents),
    money('当前月限', card.monthlyLimitCents),
    isCredit ? money('当前授信额度', card.creditLimitCents ?? 0) : undefined,
    isCredit ? money('当前已用额度', card.usedCreditCents ?? 0) : undefined,
    daily === undefined ? undefined : money('本次调整为日限', yuanToCents(daily)),
    monthly === undefined ? undefined : money('本次调整为月限', yuanToCents(monthly)),
    credit === undefined ? undefined : money('本次调整为授信额度', yuanToCents(credit)),
  ])
}

/** 交易限制：卡尾号 / 动作 / 范围 / 现有同类限制条数。 */
async function cardRestrictionDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const card = await cardOf(deps, userId, args)
  if (card === undefined) return []
  const mode = argEnum(args, 'mode', ['set', 'clear'] as const) ?? 'set'
  const kind = argEnum(args, 'kind', ['online', 'overseas', 'category'] as const)
  const value = argStr(args, 'value')
  const scope =
    kind === undefined
      ? undefined
      : kind === 'category' && value !== undefined
        ? `${RESTRICTION_LABEL[kind]}（${isMerchantCategory(value) ? MERCHANT_LABEL[value] : value}）`
        : RESTRICTION_LABEL[kind]
  const existing = card.restrictions ?? []
  const sameKind = kind === undefined ? existing : existing.filter((item) => item.kind === kind)

  return rowsOf([
    row('卡片', `尾号 ${card.tail}（${CARD_STATUS_LABEL[card.status]}）`),
    row(
      '本次操作',
      mode === 'set' ? `设置限制：${scope ?? '（未指定范围）'}` : `解除限制：${scope ?? '该卡全部限制'}`,
    ),
    row('现有同类限制', `${String(sameKind.length)} 条`),
    row('备注', argStr(args, 'note')),
  ])
}

/** 卡片状态变更（冻结 / 解冻 / 挂失）：尾号 + `from → to`。 */
async function cardStateDetails(
  deps: BankToolDeps,
  userId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const card = await cardOf(deps, userId, args)
  if (card === undefined) return []
  const to =
    name === 'card_freeze'
      ? CARD_STATUS_LABEL.frozen
      : name === 'card_unfreeze'
        ? CARD_STATUS_LABEL.normal
        : '已挂失（不可逆）'
  return rowsOf([
    row('卡片', `尾号 ${card.tail}（${CARD_TYPE_LABEL[card.type]}）`),
    row('状态变更', `${CARD_STATUS_LABEL[card.status]} → ${to}`, 'risk'),
    name === 'card_freeze' ? row('冻结原因', argStr(args, 'reason')) : undefined,
  ])
}

/* ── 订阅 ─────────────────────────────────────────────────────────────────── */

/** 按 `subscriptionId` 取订阅。 */
async function subscriptionOf(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Subscription | undefined> {
  const id = argStr(args, 'subscriptionId')
  if (id === undefined) return undefined
  const list = await read(() => deps.core.listSubscriptions(bankIds.user(userId)))
  return list?.find((item) => String(item.id) === id)
}

/** 取消订阅：商户 / 每期金额 / 下一次扣费 / 合约期 / 取消方式 / 同商户其余在扣项。 */
async function subCancelDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const subscription = await subscriptionOf(deps, userId, args)
  if (subscription === undefined) return []
  const mode = argEnum(args, 'mode', ['now', 'at-next-cycle'] as const) ?? 'now'
  const all = await read(() => deps.core.listSubscriptions(bankIds.user(userId)))
  const key = subscription.merchantKey ?? normalizeMerchant(subscription.merchant)
  const siblings =
    all === undefined
      ? undefined
      : all.filter(
          (item) =>
            String(item.id) !== String(subscription.id) &&
            item.status === 'active' &&
            (item.merchantKey ?? normalizeMerchant(item.merchant)) === key,
        )

  return rowsOf([
    row('商户', subscription.merchant),
    money(`${CYCLE_LABEL[subscription.cycle]}扣款`, subscription.amountCents),
    row('下一次扣费', dateText(subscription.nextChargeAt), 'date'),
    subscription.contractEndAt === undefined || subscription.contractEndAt <= 0
      ? undefined
      : row('合约期至', dateText(subscription.contractEndAt), 'date'),
    row('取消方式', CANCEL_MODE_LABEL[mode]),
    siblings === undefined
      ? undefined
      : row('同商户其余在扣项', siblings.length === 0 ? '无' : `${String(siblings.length)} 项`),
  ])
}

/** 订阅提醒：商户 / 每期金额 / 下一次扣费 / 提醒设置 / 对扣款的影响。 */
async function subWatchDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const subscription = await subscriptionOf(deps, userId, args)
  if (subscription === undefined) return []
  const watch = argEnum(args, 'watch', ['remind', 'idle', 'none'] as const)
  if (watch === undefined) return []
  const ahead = argNum(args, 'aheadDays')
  return rowsOf([
    row('商户', subscription.merchant),
    money('每期扣款', subscription.amountCents),
    row('下一次扣费', dateText(subscription.nextChargeAt), 'date'),
    row(
      '本次设置',
      watch === 'remind' && ahead !== undefined
        ? `${WATCH_LABEL[watch]}（提前 ${String(ahead)} 天）`
        : WATCH_LABEL[watch],
    ),
    row('对扣款的影响', '仅提醒/标注，不改变扣款'),
  ])
}

/** 关闭代扣协议：商户 / 影响订阅数 / 只关不开。 */
async function subAuthorizeDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const merchant = argStr(args, 'merchant')
  if (merchant === undefined) return []
  const key = normalizeMerchant(merchant)
  const all = await read(() => deps.core.listSubscriptions(bankIds.user(userId)))
  const affected =
    all === undefined
      ? undefined
      : all.filter(
          (item) =>
            item.status === 'active' &&
            (item.merchantKey ?? normalizeMerchant(item.merchant)) === key,
        )
  return rowsOf([
    row('商户', affected?.[0]?.merchant ?? merchant),
    affected === undefined
      ? undefined
      : row('影响订阅', affected.length === 0 ? '无在扣订阅' : `${String(affected.length)} 项`),
    affected === undefined || affected.length === 0
      ? undefined
      : money('在扣合计', affected.reduce((sum, item) => sum + item.amountCents, 0)),
    row('协议状态', '只关不开（恢复需商户侧重新签约）'),
  ])
}

/* ── AA 收款 ──────────────────────────────────────────────────────────────── */

/**
 * AA 明细：建组说份额，表态说"谁、哪一组、这次动多少钱"。
 *
 * **不含手机号**（PII 最小化）。份额用 `equalShares`（工具执行时的同一个函数），
 * 均分有余额时如实写出首位多出的一分钱，不四舍五入把它抹掉。
 *
 * `collect/decline/close` 的组与参与人从 core 现读，不用模型参数当事实：
 * 参数只负责"定位谁"，写下的是账本上的姓名与份额。
 */
async function aaDetails(
  deps: BankToolDeps,
  userId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly TicketDetail[]> {
  const action =
    argEnum(args, 'action', ['create', 'status', 'collect', 'decline', 'close'] as const) ??
    'create'
  if (action === 'status') return []
  if (action !== 'create') {
    const groupId = argStr(args, 'groupId')
    if (groupId === undefined) return []
    const group = await read(() => deps.core.getAa(bankIds.user(userId), groupId as AaGroupId))
    if (group === undefined) return []

    if (action === 'close') {
      const pending = group.participants.filter((participant) => participant.status === 'pending')
      const pendingCents = pending.reduce((sum, participant) => sum + participant.shareCents, 0)
      return rowsOf([
        row('动作', '提前结束收款'),
        row('组', `${group.title}（${groupId}）`),
        row('剩余未付', `${String(pending.length)} 人 · ${formatYuan(pendingCents)}`),
        row('收口结果', pending.length === 0 ? '没有待收，直接按已收情况收口' : '剩余未付转为已过期；已收部分保留'),
      ])
    }

    const selector = argStr(args, 'participant')
    let index: number | undefined
    if (selector !== undefined) {
      if (/^\d+$/.test(selector)) {
        const candidate = Number(selector)
        if (Number.isInteger(candidate) && candidate >= 0 && candidate < group.participants.length) {
          index = candidate
        }
      } else {
        const matches = group.participants
          .map((participant, position) => ({ participant, position }))
          .filter((item) => item.participant.name === selector)
        if (matches.length === 1) index = matches[0]!.position
      }
    }
    const target = index === undefined ? undefined : group.participants[index]!
    return rowsOf([
      row('动作', action === 'collect' ? '模拟代收一位参与人' : '记录一位参与人拒绝'),
      row('组', `${group.title}（${groupId}）`),
      row('参与人', target?.name ?? selector),
      money('份额', target?.shareCents),
      row(
        '本次入账',
        action === 'collect'
          ? target === undefined
            ? undefined
            : formatYuan(target.shareCents)
          : '0（拒绝不入账）',
      ),
    ])
  }

  const raw = args['participants']
  if (!Array.isArray(raw) || raw.length === 0) return []
  const totalYuan = argNum(args, 'totalYuan')
  const totalCents = totalYuan === undefined ? undefined : yuanToCents(totalYuan)
  const split = argEnum(args, 'split', ['equal', 'custom'] as const) ?? 'equal'

  let shareText: string | undefined
  if (totalCents !== undefined && totalCents > 0) {
    if (split === 'equal') {
      try {
        const shares = equalShares(totalCents, raw.length)
        const base = shares[shares.length - 1] ?? 0
        const first = shares[0] ?? 0
        shareText =
          first === base
            ? `均分 ${formatYuan(base)}/人`
            : `均分 ${formatYuan(base)}/人（首位 ${formatYuan(first)}，含余数）`
      } catch {
        shareText = undefined
      }
    } else {
      const shares: number[] = []
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue
        const yuan = argNum(item as Readonly<Record<string, unknown>>, 'shareYuan')
        if (yuan === undefined) continue
        shares.push(yuanToCents(yuan))
      }
      shareText =
        shares.length === 0
          ? '自定义份额'
          : `自定义 ${formatYuan(Math.min(...shares))}–${formatYuan(Math.max(...shares))}`
    }
  }

  return rowsOf([
    row('标题', argStr(args, 'title')),
    money('总额', totalCents),
    row('参与人数', `${String(raw.length)} 人`),
    row('每人份额', shareText),
  ])
}

/**
 * 交易密码明细（ADR-0014）：审批卡要说清"批准之后会发生什么"，以及**密码去哪**。
 *
 * 这里**不读 args 里的任何密码**——`password_change` 的 args 只有 `action`，
 * 这条明细因此结构上不可能带出密码材料。交接页与 TTL 都来自常量，不手抄数字。
 */
function passwordDetails(args: Readonly<Record<string, unknown>>): readonly TicketDetail[] {
  const action = argEnum(args, 'action', ['request', 'status'] as const) ?? 'request'
  if (action === 'status') return []
  return rowsOf([
    row('操作', '发起交易密码修改（交办，不代改）'),
    row('交接页', PASSWORD_HANDOFF_PATH),
    row('票据有效期', `${String(PASSWORD_HANDOFF_TTL_SECONDS)} 秒（一次性）`),
    row('密码去哪', '只在安全页表单里提交；不进模型、不进会话日志'),
    row('事后', '改密成功落 security/password-changed（不含任何密码材料）'),
  ])
}
