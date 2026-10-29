/**
 * `WebFrame[]` → 微信出站消息的**纯投影**（施工单 01 §2.4）。
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
  FrameTier,
  HandoffFrame,
  MessageBlock,
  NoticeFrame,
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

/** 审批摘要（标题 / 金额 / 收款人 / 层级 / 强验证 / 截止；**不含链接**）。 */
function approvalText(frame: ApprovalFrame): string {
  const lines = [`【审批】${frame.operation}`]
  lines.push(`金额：${frame.amountText ?? '待确认'}`)
  if (frame.payeeName !== undefined) lines.push(`收款人：${frame.payeeName}`)
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
    // 表外帧：公众号没有对应呈现面（流式 / 图形 / 时间线 / 快照），一律丢弃
    case 'delta':
    case 'turn':
    case 'audit':
    case 'dag':
    case 'choice':
    case 'goal':
    case 'todo':
    case 'effects':
    case 'handoff-warn':
    case 'snapshot':
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
