/**
 * 工具结果 → 渠道卡片（施工单 13 §4 步 4「工具卡片三态 + presenter 数据管线」）。
 *
 * **数据来源的现实约束**：`UiCard`（`presentCall` / `presentResult` 的产物）当前**不落账**，
 * 会话日志里只有 `tool/call.args` 与 `tool/result.content`（施工单 03 的冻结面）。
 * 因此渠道卡片只能从**已持久化**的两处派生：
 *
 * ```text
 * tool/call.args ─┐
 *                 ├─▶ CardView（fields + body + disclaimer）
 * tool/result ────┘
 * ```
 *
 * 这不是妥协的"猜"：`projectContent` 的正文里本来就写了金额、收款人、余额与
 * **风险提示 ID**（施工单 08 的合规硬约束），渠道只是把它**排版**出来。
 * 若将来 `tool/call` 带上 `UiCard`，只需换本文件的输入，视图不动（登记 R-WEB-D6）。
 *
 * 纯函数：不访问 ctx / 时间 / 随机；不抛错（参数来自不可信的模型）。
 */

import type { CardField, CardView, FrameTag } from './frames.ts'
import { amountFromArgs, amountText, extractDisclaimer, payeeFromArgs } from './amount.ts'

/** 工具名的中文标题（渠道文案；未登记的工具退回工具名本身，不猜语义）。 */
const TOOL_TITLE: Readonly<Record<string, string>> = {
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
  knowledge_answer: '知识问答',
  knowledge_query: '知识检索',
}

/** 工具名 → 模板。 */
function templateOf(name: string): CardView['template'] {
  if (name.startsWith('transfer')) return 'transfer'
  if (name.startsWith('wealth')) return 'wealth'
  if (name.startsWith('account') || name.startsWith('txn') || name.startsWith('bill')) return 'ledger'
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

/** 卡片构造的输入（全部来自会话事件）。 */
export interface CardInput {
  readonly name: string
  readonly args: unknown
  readonly content: readonly { type: string; text?: string; mimeType?: string }[]
  readonly code?: string
  readonly isError: boolean
  /** 本 turn 内该调用是否已有成功结果（金额确认依据）。 */
  readonly amountConfirmed: boolean
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

  return {
    kind: `tool.${input.name}`,
    template,
    title,
    fields,
    tags,
    ...(disclaimer === undefined ? {} : { disclaimer }),
    ...(cleanBody.length === 0 ? {} : { body: cleanBody }),
    ...(input.code === undefined ? {} : { code: input.code }),
  }
}
