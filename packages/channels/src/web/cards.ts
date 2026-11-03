/**
 * 工具结果 → 渠道卡片。
 *
 * **数据来源的现实约束**：`UiCard`（`presentCall` / `presentResult` 的产物）当前**不落账**，
 * 会话日志里只有 `tool/call.args` 与 `tool/result.content`。
 * 因此渠道卡片只能从**已持久化**的两处派生：
 *
 * ```text
 * tool/call.args ─┐
 *                 ├─▶ CardView（fields + body + disclaimer）
 * tool/result ────┘
 * ```
 *
 * 这不是妥协的"猜"：`projectContent` 的正文里本来就写了金额、收款人、余额与
 * **风险提示 ID**，渠道只是把它**排版**出来。
 * 若将来 `tool/call` 带上 `UiCard`，只需换本文件的输入，视图不动（登记 R-WEB-D6）。
 *
 * 纯函数：不访问 ctx / 时间 / 随机；不抛错（参数来自不可信的模型）。
 */

import type { CardField, CardView, FrameTag } from './frames.ts'
import { aaBlockOf, type AaProgress } from './aa.ts'
import type { BillReportBlock } from './bill-report.ts'
import type { UpcomingBlock } from './subscriptions.ts'
import { amountFromArgs, amountText, extractDisclaimer, payeeFromArgs } from './amount.ts'

/** 工具名的中文标题（渠道文案；未登记的工具退回工具名本身，不猜语义）。 */
const TOOL_TITLE: Readonly<Record<string, string>> = {
  aa_create: 'AA 收款',
  account_list: '账户列表',
  account_balance: '余额查询',
  txn_query: '交易流水',
  bill_analyze: '账单分析',
  bill_report: '账单报告',
  analysis_calc: '受限计算',
  transfer_preview: '转账预演',
  transfer_create: '转账',
  wealth_list: '理财产品',
  wealth_compare: '产品对比',
  wealth_purchase: '理财购买',
  verify_face: '人脸强验证',
  verify_sms: '短信强验证',
  verify_ushield: 'U 盾强验证',
  card_report_lost: '挂失银行卡',
  card_freeze: '冻结银行卡',
  card_unfreeze: '解冻银行卡',
  sub_cancel: '取消订阅',
  knowledge_answer: '知识问答',
  knowledge_query: '知识检索',
  sub_list: '订阅与自动扣款',
  sub_watch: '订阅提醒',
  sub_authorize: '关闭代扣协议',
  // 计划域（宿主工具）：审批卡上的「操作类型」走这张表，**不许**在视图里硬编码
  // 「转账」——`birthday_plan` 批一次就等于批了三笔不同的钱。
  plan_propose: '校验计划',
  plan_execute: '执行计划',
  plan_arm: '定时计划授权',
  plan_disarm: '撤销定时计划',
  plan_wake: '到期唤醒',
  transfer_schedule: '定时转账',
  birthday_plan: '生日定时计划',
}

/** 工具名 → 模板。 */
function templateOf(name: string): CardView['template'] {
  if (name.startsWith('transfer')) return 'transfer'
  if (name.startsWith('wealth')) return 'wealth'
  // 订阅三工具与卡清单同属台账形态：一行一项、金额与日期并排
  if (name.startsWith('account') || name.startsWith('txn') || name.startsWith('bill')) return 'ledger'
  if (name.startsWith('sub_')) return 'ledger'
  // AA 组与订阅同属台账形态：一人一行，份额与是否已收并排
  if (name === 'aa_create') return 'ledger'
  if (name === 'analysis_calc') return 'analysis'
  if (name.startsWith('verify')) return 'verify'
  if (name.startsWith('knowledge')) return 'knowledge'
  return 'generic'
}

/** 工具名 → 中文标题。 */
export function toolTitle(name: string): string {
  return TOOL_TITLE[name] ?? name
}

/** 内容块 → 纯文本（图片等非文本块只留摘要，不丢"有内容"这个事实）。 */
export function blocksToText(blocks: readonly { type: string; text?: string; mimeType?: string }[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[图片 ${block.mimeType ?? 'unknown'}]`)
    else parts.push('[非文本内容]')
  }
  return parts.join('\n')
}

/** 从正文里去掉风险提示那一行（它会单独渲染成不折叠的提示块，避免重复）。 */
function stripDisclaimerLine(body: string, id: string): string {
  return body
    .split('\n')
    .filter((line) => !(line.includes('风险提示') && line.includes(id)))
    .join('\n')
    .trim()
}

/**
 * 从正文里去掉参与人清单行（`- 张三：¥100.00（已收）`）。
 *
 * 契约：`packages/bank/src/tools/aa.ts` 的 `projectContent` 拼这份清单，行首固定 `- `。
 * 那边改了行首，这里必须同步——否则卡片会"表里一份、正文又列一遍"。
 * 只在 `aa` 有值时调用（`buildCard` 里把关），不会误伤别的工具正文。
 */
function stripParticipantLines(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('- '))
    .join('\n')
    .trim()
}

/** 卡片构造的输入（全部来自会话事件）。 */
export interface CardInput {
  readonly name: string
  readonly args: unknown
  readonly content: readonly { type: string; text?: string; mimeType?: string }[]
  readonly code?: string
  readonly isError: boolean
  /** 本 turn 内该调用是否已有成功结果（金额确认依据）。 */
  readonly amountConfirmed: boolean
  /** 订阅卡片的「即将扣款」块（由 `read/subscriptions` 事件派生；其它工具不传）。 */
  readonly upcoming?: UpcomingBlock
  /**
   * AA 收款进度（由 `aa/created` + 逐条 `aa/collected` 派生；只有 `aa_create` 传）。
   *
   * 与 `upcoming` 一样是「事件回放派生」，不是"从正文里抠"：正文那份参与人清单是
   * 给人读的（`bank/src/tools/aa.ts` 的 `projectContent`），表格要靠结构化数据。
   */
  readonly aa?: AaProgress
  /**
   * 账单报告的结构化块（由 `read/bill-report` 事件派生；只有 `bill_report` 传）。
   *
   * 有了它就**不再显示正文**：报告文本和字段/表格是同一份数字，两份都摆出来读起来
   * 像两笔账（与 AA 参与人清单同一处理）。
   */
  readonly billReport?: BillReportBlock
}

/**
 * 构造卡片。
 *
 * 金额字段永远标 `amount: true`：视图据此套用降级规则（未确认 → 灰 + 待确认）。
 */
export function buildCard(input: CardInput): CardView {
  const template = templateOf(input.name)
  const title = toolTitle(input.name)
  const body = blocksToText(input.content)
  const disclaimer = extractDisclaimer(body)
  const cents = amountFromArgs(input.args)
  const payee = payeeFromArgs(input.args)

  const fields: CardField[] = []
  if (cents !== undefined) {
    fields.push({
      label: '金额',
      value: amountText(cents) ?? '—',
      amount: true,
      mono: true,
    })
  }
  if (payee !== undefined) fields.push({ label: '收款人', value: payee })
  if (input.code !== undefined) fields.push({ label: '理由码', value: input.code, mono: true, tone: 'danger' })

  const tags: FrameTag[] = []
  if (disclaimer !== undefined) tags.push({ text: '理财非存款', tone: 'warning' })
  if (template === 'knowledge') tags.push({ text: '知识校验', tone: 'brand' })
  if (input.isError) tags.push({ text: '未执行', tone: 'danger' })

  const cleanBody = disclaimer === undefined ? body : stripDisclaimerLine(body, disclaimer.id)

  // AA 收款进度（场景 1 子能力）：摘要进字段，明细进表，人数与总额进 note。
  // 有了表就把正文里的参与人清单去掉——同一份名单出现两次，读起来像两批人。
  const aa = input.aa === undefined ? undefined : aaBlockOf(input.aa)
  // 账单报告块（场景 2 子能力）：账期/收支/环比/异常进字段，分类进表，收款人与异常说明进 note。
  // 整段报告正文与这三块是同一份数字，所以有了块就**不再出正文**（`bodyText` 置空即被上面的
  // 空串判断丢掉）。
  const billReport = input.billReport
  const bodyText =
    billReport !== undefined ? '' : aa === undefined ? cleanBody : stripParticipantLines(cleanBody)

  // 订阅卡片的「即将扣款」块：摘要进字段，明细进表，依据进 note（ADR-0007 §4.6 要求卡片
  // 写明"基于近 N 天 M 笔流水、生成于哪一刻"，否则推断会被读成现况）。
  if (input.upcoming !== undefined) {
    fields.push({ label: '即将扣款', value: input.upcoming.summary })
  }
  if (aa !== undefined) {
    fields.push({ label: '收款进度', value: aa.summary })
  }
  if (billReport !== undefined) fields.push(...billReport.fields)

  // 三张表互斥（`sub_list` / `aa_create` / `bill_report` 不会同时出现）；谁有数据用谁。
  const table =
    billReport?.table !== undefined
      ? billReport.table
      : aa !== undefined
        ? { headers: aa.headers, rows: aa.rows }
        : input.upcoming === undefined || input.upcoming.rows.length === 0
          ? undefined
          : { headers: input.upcoming.headers, rows: input.upcoming.rows }
  const note = billReport?.note ?? (aa !== undefined ? aa.note : input.upcoming?.basisNote)

  return {
    kind: `tool.${input.name}`,
    template,
    title,
    fields,
    tags,
    ...(disclaimer === undefined ? {} : { disclaimer }),
    ...(table === undefined ? {} : { table }),
    ...(note === undefined ? {} : { note }),
    ...(bodyText.length === 0 ? {} : { body: bodyText }),
    ...(input.code === undefined ? {} : { code: input.code }),
  }
}
