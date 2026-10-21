/**
 * 渠道抽象的第一个实现：Web（施工单 13 §1）。
 *
 * 适配器**只做转换**，这是本文件唯一职责：
 * - 入站：浏览器消息 → 内核输入（转发文本打 `untrusted`）；
 * - 出站：会话事件 → 渲染原语（帧）；
 * - 审批：把"人点了哪个按钮"翻译成仲裁器能接受的结论。
 *
 * 不做的事（都在别处，故意的）：
 * - 不碰 HTTP / SSE（宿主插件 `channel:web`）；
 * - 不碰 DOM（`apps/web`）；
 * - 不推导业务（`project.ts` 的纯归约）。
 */

import type { AnySessionEvent, ApprovalDecision } from '@bah/runtime'
import { BahError } from '@bah/util'

import type { WebFrame } from './frames.ts'
import { projectSession } from './project.ts'

/** 渠道能力位（上报内核，系统提示词按能力位裁剪 section）。 */
export interface ChannelCapabilities {
  readonly richCards: boolean
  readonly buttons: boolean
  readonly forms: boolean
  readonly images: boolean
  /** 是否支持流式增量（Web = true；IM 卡片 = false）。 */
  readonly streaming: boolean
}

/** 入站消息（渠道 → 适配器）。 */
export interface ChannelMessage {
  readonly text: string
  readonly at?: number
  /** 来源（第三方转发时存在；直接输入没有）。 */
  readonly from?: string
}

/** 内核输入（适配器 → 主循环）。 */
export interface InboundInput {
  readonly text: string
  /** 第三方转发文本一律视为不可信（施工单 13 §1）。 */
  readonly untrusted: boolean
  readonly at?: number
  readonly from?: string
}

/** 渠道适配器契约（施工单 13 §1 的落地版）。 */
export interface ChannelAdapter {
  readonly id: 'web' | 'mobile' | 'im' | 'desktop' | 'cli'
  readonly capabilities: ChannelCapabilities
  inbound(message: ChannelMessage): InboundInput
  render(events: readonly AnySessionEvent[]): Promise<readonly WebFrame[]>
}

/** 审批视图（仲裁器 `ApprovalView` 的结构面；不 import interaction，避免渠道包依赖审批实现）。 */
export interface ApprovalViewLike {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly signal: AbortSignal
  /** 红级强验证句柄（仅需挑战的审批有）。 */
  readonly challenge?: ChallengeViewLike
  answer(answer: {
    readonly decision: ApprovalDecision
    readonly reason?: string
  }): { readonly accepted: boolean; readonly code?: string }
}

/** 强验证句柄（仲裁器 `ChallengeView` 的结构面）。 */
export interface ChallengeViewLike {
  readonly channel: 'face' | 'sms' | 'ushield'
  verify(): Promise<{ readonly ok: boolean; readonly code?: string; readonly reason?: string }>
}

/** 审批应答的判定结果（插件据此选 HTTP 状态码）。 */
export type DecideResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: 'unknown-ticket' | 'invalid-decision' | 'reason-required' | 'already-decided' | 'expired'
      readonly reason: string
    }

/** 强验证结论（HTTP 层据此选状态码）。 */
export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** Web 渠道的公开面。 */
export interface WebChannelAdapter extends ChannelAdapter {
  readonly id: 'web'
  /** 登记一次待应答的审批（`ApprovalResponder.attach` 的实现体，必须立即返回）。 */
  attachApproval(view: ApprovalViewLike): void
  /** 提交人的结论；返回判定（HTTP 层只翻译，不做业务判断）。 */
  decide(ticketId: string, body: { readonly decision?: unknown; readonly reason?: unknown }): DecideResult
  /** 执行一次强验证（红级）；无挑战的票据返回 `no-challenge`。 */
  verify(ticketId: string): Promise<VerifyResult>
  /** 仍待应答的票据 ID（运维 / 健康检查用）。 */
  pendingTickets(): readonly string[]
  /** 注销全部在途审批（插件 dispose 时调用）。 */
  dispose(): void
}

/** 合法结论。 */
const DECISIONS: readonly ApprovalDecision[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** 拒绝理由的最大长度（落审计，防止被塞整篇文章）。 */
const MAX_REASON = 500

/** Web 能力位：全量（富卡片 / 按钮 / 表单 / 图片 / 流式）。 */
const WEB_CAPABILITIES: ChannelCapabilities = {
  richCards: true,
  buttons: true,
  forms: true,
  images: true,
  streaming: true,
}

/** 造一个 Web 渠道适配器。 */
export function createWebChannelAdapter(): WebChannelAdapter {
  const pending = new Map<string, ApprovalViewLike>()

  return {
    id: 'web',
    capabilities: WEB_CAPABILITIES,

    inbound(message) {
      const text = message.text.trim()
      if (text.length === 0) {
        // 空文本不该进主循环（否则会落一条空 user/message）；抛结构化错误由 HTTP 层翻 400
        throw new BahError('web-empty-message', 'web: 空消息不入队')
      }
      return {
        text,
        untrusted: message.from !== undefined,
        ...(message.at === undefined ? {} : { at: message.at }),
        ...(message.from === undefined ? {} : { from: message.from }),
      }
    },

    async render(events) {
      return projectSession(events).frames
    },

    attachApproval(view) {
      pending.set(view.ticketId, view)
      view.signal.addEventListener('abort', () => {
        if (pending.get(view.ticketId) === view) pending.delete(view.ticketId)
      })
    },

    decide(ticketId, body) {
      const view = pending.get(ticketId)
      if (view === undefined) {
        return { ok: false, code: 'unknown-ticket', reason: `没有待应答的票据 ${ticketId}` }
      }

      const decision = body.decision
      if (typeof decision !== 'string' || !(DECISIONS as readonly string[]).includes(decision)) {
        return { ok: false, code: 'invalid-decision', reason: '结论必须是 allowed-once / rejected / cancelled / unavailable' }
      }

      const rawReason = body.reason
      const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
      if (decision === 'rejected' && reason.length === 0) {
        return { ok: false, code: 'reason-required', reason: '拒绝必须填写理由（落审计）' }
      }
      if (reason.length > MAX_REASON) {
        return { ok: false, code: 'reason-required', reason: `拒绝理由不得超过 ${String(MAX_REASON)} 字` }
      }

      const receipt = view.answer({
        decision: decision as ApprovalDecision,
        ...(reason.length === 0 ? {} : { reason }),
      })
      if (!receipt.accepted) {
        return {
          ok: false,
          code: receipt.code === 'expired' ? 'expired' : 'already-decided',
          reason: receipt.code === 'expired' ? '票据已过期，结论未采纳' : '该票据已有结论（先到者胜出）',
        }
      }

      pending.delete(ticketId)
      return { ok: true }
    },

    async verify(ticketId) {
      const view = pending.get(ticketId)
      if (view === undefined) {
        return { ok: false, code: 'unknown-ticket', reason: `没有待应答的票据 ${ticketId}` }
      }
      if (view.challenge === undefined) {
        return { ok: false, code: 'no-challenge', reason: '该票据不需要强验证' }
      }
      const verdict = await view.challenge.verify()
      return verdict.ok
        ? { ok: true }
        : { ok: false, code: verdict.code ?? 'verify-failed', reason: verdict.reason ?? '强验证未通过' }
    },

    pendingTickets() {
      return [...pending.keys()]
    },

    dispose() {
      pending.clear()
    },
  }
}
