/**
 * `WebFrame[]` → 微信出站消息的**纯投影**。
 *
 * WHY 单独一层而不是"帧直接拼字符串"：同一串事件必须投影出同一串消息
 * （无时钟、无随机、无 `Date.now()`），否则"重放后对话不一致"就无法归因。
 *
 * 边界（01 §2.4 的映射表是唯一口径）：
 * - 只投影**IM 能承载**的呈现面：文本、审批摘要、拦截提示、坐席发言、接管状态；
 * - `delta` / `tool done` / `dag` / `audit` / `snapshot` 等一律丢弃（公众号无流式、无图形面）；
 * - 审批**不生成链接**：H5 链接要签名（03 单），投影层不持有密钥；
 * - 不截断、不分片：`maxTextBytes` 与长文分片由 02 单的出站层负责。
 */

import { assertNever } from '@bah/util'

import type {
  ApprovalClosedFrame,
  ApprovalFrame,
  ChoiceFrame,
  FrameTier,
  HandoffFrame,
  MessageBlock,
  NoticeFrame,
  RiskQuestionnaireFrame,
  ToolFrame,
  WebFrame,
} from '../web/frames.ts'

/** IM 出站消息（平台无关形态；适配器只读 `text`）。 */
export type ImOutbound =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'approval'
      readonly ticketId: string
      readonly text: string
      readonly tier: FrameTier
      readonly expiresAt?: number
      readonly challenge?: 'face' | 'sms' | 'ushield'
    }
  | { readonly kind: 'handoff'; readonly text: string }

/** 层级的中文口径（IM 用户不看英文枚举）。 */
const TIER_LABEL: Readonly<Record<FrameTier, string>> = {
  green: '低风险',
  yellow: '中风险',
  red: '高风险',
  unknown: '未标注',
}

/** 强验证方式的中文口径。 */
const CHALLENGE_LABEL: Readonly<Record<'face' | 'sms' | 'ushield', string>> = {
  face: '人脸识别',
  sms: '短信验证码',
  ushield: 'U 盾',
}

/** 一条消息的块 → 纯文本（图片给 `[图片]`，其它块给平台提供的摘要）。 */
function blocksText(blocks: readonly MessageBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'image':
          return '[图片]'
        case 'other':
          return block.summary
        default:
          return assertNever(block, 'message-block')
      }
    })
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

/**
 * 审批摘要（标题 / 金额 / 收款人 / 层级 / 强验证 / 截止；**不含链接**）。
 *
 * 有 `details` 时**不再输出金额与收款人行**：明细里已经有服务端签发的同一份数字，
 * 两行并列会让人在"两个金额不一致时信哪个"上犯难。明细由网关的文本出口按
 * 「标签：值」逐行追加（`apps/im-gateway/src/approval/texts.ts`）。
 */
function approvalText(frame: ApprovalFrame): string {
  const lines = [`【审批】${frame.operation}`]
  const hasDetails = frame.details !== undefined && frame.details.length > 0
  if (!hasDetails) {
    lines.push(`金额：${frame.amountText ?? '待确认'}`)
    if (frame.payeeName !== undefined) lines.push(`收款人：${frame.payeeName}`)
  }
  lines.push(`层级：${TIER_LABEL[frame.tier]}`)
  if (frame.challenge !== undefined) lines.push(`强验证：${CHALLENGE_LABEL[frame.challenge]}`)
  // 只做格式化：`expiresAt` 原样来自帧，本函数不取当前时间
  if (frame.expiresAt !== undefined) lines.push(`有效期至：${new Date(frame.expiresAt).toISOString()}`)
  return lines.join('\n')
}

/** 审批收尾文本（结论 + 人话标签 + 可选理由/理由码）。 */
function closedText(frame: ApprovalClosedFrame): string {
  const lines = [`【审批结果】${frame.label}（${frame.decision}）`]
  if (frame.reason !== undefined && frame.reason.length > 0) lines.push(`理由：${frame.reason}`)
  if (frame.code !== undefined) lines.push(`代码：${frame.code}`)
  return lines.join('\n')
}

/** 提示文本（`warning` / `danger` 才发，避免 IM 刷屏）。 */
function noticeText(frame: NoticeFrame): string {
  const body = frame.text === undefined || frame.text.length === 0 ? '' : `：${frame.text}`
  const code = frame.code === undefined ? '' : `（${frame.code}）`
  return `【提示】${frame.title}${body}${code}`
}

/** 被拦截的工具调用（判决拦截 / 执行失败都走这里，文案不同由 `reasonKind` 决定）。 */
function deniedText(frame: ToolFrame): string {
  const reason = frame.reason === undefined || frame.reason.length === 0 ? '未提供理由' : frame.reason
  const code = frame.code === undefined ? '' : `（${frame.code}）`
  return `【已拦截】${frame.name}：${reason}${code}`
}

/** 接管状态摘要（进入 / 认领 / 交回）。 */
function handoffText(frame: HandoffFrame): string {
  if (!frame.active) return '【转人工】已交回智能助手'
  const operator = frame.operator === undefined ? '' : `（坐席：${frame.operator}）`
  const reason = frame.reason === undefined || frame.reason.length === 0 ? '' : `：${frame.reason}`
  return `【转人工】已进入人工服务${operator}${reason}`
}

/**
 * 选择题（`prompt_ask`）。
 *
 * WHY 必须投影：IM 没有卡片面，若丢弃 `choice`，用户只会看到模型另发的一句
 * 「请选择一下」，**看不到候选**，也就无法回答——真机 D0 已实测踩到。
 *
 * 只列**候选文字**、不编号：宿主回填走的是 label（不是序号），给序号会制造
 * "回复 1 就能选中"的假承诺（网关的 `1` 是审批指令，二者语义不同）。
 */
function choiceText(frame: ChoiceFrame): string {
  const lines = [`【请选择】${frame.prompt}`]
  for (const option of frame.options) {
    lines.push(
      option.hint === undefined || option.hint.length === 0
        ? `· ${option.label}`
        : `· ${option.label}（${option.hint}）`,
    )
  }
  if (frame.allowFreeText) lines.push('回复候选文字，或直接输入。')
  return lines.join('\n')
}

/**
 * 风险问卷（IM 文本出口）。
 *
 * IM 没有表单控件，也**没有逐题累积的会话槽位**（网关侧的待办状态只有审批与计划，
 * 再加一份"答到第几题"就是第二份问卷状态，且它一旦丢消息就再也对不上）。
 * 所以这里给一条**一次成型的作答格式**：用户复制模板、把每题换成自己的选项，
 * 一条消息发回来，服务端按整串校验（齐全性 / 归属 / 过期都在核心判定）。
 *
 * 键用英文 `conservative / middle / aggressive` 而不是 1/2/3：序号→键的映射
 * 只有服务端常量表知道，在渠道里再写一份就会在改题序时静默错位。
 */
function riskQuestionnaireText(frame: RiskQuestionnaireFrame): string {
  const lines = [`【风险测评】共 ${String(frame.questions.length)} 题，请由本人逐题作答。`]
  for (const question of frame.questions) {
    lines.push(`第 ${String(question.index)} 题 ${question.title}`)
    for (const option of question.options) {
      lines.push(`  · ${option.key} = ${option.text}（${String(option.score)} 分）`)
    }
  }
  const template = frame.questions
    .map((question) => `${String(question.index)}=${question.options[0]?.key ?? 'conservative'}`)
    .join(' ')
  lines.push(
    `作答格式（把等号右边换成你的选项后整条回复）：风险测评作答 ${frame.questionnaireId} ${template}`,
  )
  return lines.join('\n')
}

/** 单帧投影；`undefined` = 这一帧不进 IM。 */
function projectFrame(frame: WebFrame): ImOutbound | undefined {
  switch (frame.kind) {
    case 'message': {
      // 用户自己的话不回发（否则像机器人复读）
      if (frame.role === 'user') return undefined
      const text = blocksText(frame.blocks)
      if (text.length === 0) return undefined
      if (frame.role === 'operator') {
        const name = frame.operator === undefined || frame.operator.length === 0 ? '坐席' : frame.operator
        return { kind: 'text', text: `【坐席】${name}：${text}` }
      }
      return { kind: 'text', text }
    }
    case 'approval':
      return {
        kind: 'approval',
        ticketId: frame.ticketId,
        text: approvalText(frame),
        tier: frame.tier,
        ...(frame.expiresAt === undefined ? {} : { expiresAt: frame.expiresAt }),
        ...(frame.challenge === undefined ? {} : { challenge: frame.challenge }),
      }
    case 'approval-closed':
      return { kind: 'text', text: closedText(frame) }
    case 'notice':
      // info / success 不发：IM 里每条通知都是一条打扰
      if (frame.level === 'info' || frame.level === 'success') return undefined
      return { kind: 'text', text: noticeText(frame) }
    case 'tool':
      if (frame.state !== 'denied') return undefined
      return { kind: 'text', text: deniedText(frame) }
    case 'handoff':
      return { kind: 'handoff', text: handoffText(frame) }
    case 'choice':
      return { kind: 'text', text: choiceText(frame) }
    case 'risk-questionnaire':
      return { kind: 'text', text: riskQuestionnaireText(frame) }
    // 表外帧：公众号没有对应呈现面（流式 / 图形 / 时间线 / 快照），一律丢弃
    case 'delta':
    case 'turn':
    case 'audit':
    case 'dag':
    case 'goal':
    case 'todo':
    case 'effects':
    case 'handoff-warn':
    case 'snapshot':
    // 计划卡（G7）：IM 无卡片呈现面，按表外帧丢弃（同 dag / goal / todo / effects）
    case 'plan-card':
      return undefined
    default:
      return assertNever(frame, 'web-frame')
  }
}

/**
 * 帧序列 → IM 出站序列（**纯函数**：无时钟、无随机、无 I/O）。
 *
 * 顺序保持不变；逐帧投影，丢弃的帧不占位。
 */
export function projectImOutbound(frames: readonly WebFrame[]): readonly ImOutbound[] {
  const out: ImOutbound[] = []
  for (const frame of frames) {
    const projected = projectFrame(frame)
    if (projected !== undefined) out.push(projected)
  }
  return out
}
