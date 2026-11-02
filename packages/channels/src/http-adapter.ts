/**
 * HTTP 系渠道（web / mobile）的**唯一适配器实现**。
 *
 * 抽取原则：与传输无关、与渠道身份无关的逻辑全部在这里；渠道差异**只**允许通过
 * `{ id, capabilities }` 表达，`sessionId` 原样透传。
 *
 * WHY 不允许在 `mobile/adapter.ts` 写第二份 `decide`/`verify`：审批是安全面，语义一旦分叉，
 * 移动端就成了"绕过桌面端加固"的旁路（00 D2 的理由原文）。本文件的函数体是从
 * `web/adapter.ts`**整段平移**，不是重写——六码、文案、归属校验顺序一字未改。
 *
 * 不做的事（与 `web/adapter.ts` 原先的分工一致）：
 * - 不碰 HTTP / SSE（宿主插件 `channel:web` / `channel:mobile`）；
 * - 不碰 DOM（`apps/web`）；
 * - 不推导业务（`web/project.ts` 的纯归约）。
 */

import type { AnySessionEvent, ApprovalDecision, ChannelKind } from '@bah/runtime'
import { BahError } from '@bah/util'

import type { ChannelCapabilities } from './capabilities.ts'
import { requiredConfirmText } from './web/confirm.ts'
import type { WebFrame } from './web/frames.ts'
import { projectSession } from './web/project.ts'

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
  /** 第三方转发文本一律视为不可信。 */
  readonly untrusted: boolean
  readonly at?: number
  readonly from?: string
}

/** 渠道适配器契约。 */
export interface ChannelAdapter {
  /** 渠道 id。类型是 `ChannelKind`（六渠道权威定义），不是第二份字面量联合（01 §9 V2）。 */
  readonly id: ChannelKind
  readonly capabilities: ChannelCapabilities
  inbound(message: ChannelMessage): InboundInput
  render(events: readonly AnySessionEvent[]): Promise<readonly WebFrame[]>
}

/** 审批视图（仲裁器 `ApprovalView` 的结构面；不 import interaction，避免渠道包依赖审批实现）。 */
export interface ApprovalViewLike {
  readonly ticketId: string
  /** 票据所属会话（W04 归属校验；与适配器绑定的 sessionId 不一致即拒绝）。 */
  readonly sessionId: string
  /**
   * 票据所属用户（03 TA-43；可选）。
   *
   * 当前仲裁器还拿不到"这张票是哪个登录用户签发的"——视图没有这个字段时，
   * 用户层判定跳过，只剩会话层（与今天行为一致）。
   */
  readonly userId?: string
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
      readonly code:
        | 'unknown-ticket'
        | 'foreign-ticket'
        | 'invalid-decision'
        | 'reason-required'
        | 'already-decided'
        | 'expired'
        | 'approval-confirm-mismatch'
      readonly reason: string
    }

/** 强验证结论（HTTP 层据此选状态码）。 */
export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * 审批动作的操作者（03 TA-43）。
 *
 * `sessionId` 必须来自服务端会话（**不是**请求头）；`userId` 来自登录主体。
 * 不传 = 保持 W04 的旧行为（只判会话），供单测与纯投影场景使用。
 */
export interface TicketOwner {
  readonly sessionId: string
  readonly userId?: string
}

/** 工厂入参：渠道差异**只**允许前两个字段。 */
export interface HttpChannelAdapterOptions {
  /** 渠道 id；原样出现在 `ChannelAdapter.id` 与 `/api/session` 上报里。 */
  readonly id: ChannelKind
  /** 该渠道能力位。必须取自 `CAPABILITIES_BY_CHANNEL`，不得就地字面量（门禁 I3）。 */
  readonly capabilities: ChannelCapabilities
  /**
   * 本渠道所属会话（缺省 = 不校验归属）。
   *
   * 生产必须传：审批视图来自 `ApprovalService`，它的 `sessionId` 必须与这里一致；
   * 否则一个有效 token 就能拿别的会话的票据 ID 去批钱（W04 TC-02）。
   * WHY 在工厂层：归属校验是**审批语义**，与渠道无关——移动端同样需要。
   */
  readonly sessionId?: string
}

/** HTTP 系渠道（web / mobile）的公开面 = `ChannelAdapter` + 审批五法。 */
export interface HttpChannelAdapter extends ChannelAdapter {
  /** 登记一次待应答的审批（`ApprovalResponder.attach` 的实现体，必须立即返回）。 */
  attachApproval(view: ApprovalViewLike): void
  /** 提交人的结论；返回判定（HTTP 层只翻译，不做业务判断）。 */
  decide(
    ticketId: string,
    body: { readonly decision?: unknown; readonly reason?: unknown; readonly confirmText?: unknown },
    actor?: TicketOwner,
  ): DecideResult
  /** 执行一次强验证（红级）；无挑战的票据返回 `no-challenge`。 */
  verify(ticketId: string, actor?: TicketOwner): Promise<VerifyResult>
  /** 仍待应答的票据 ID（运维 / 健康检查用）。 */
  pendingTickets(): readonly string[]
  /** 注销全部在途审批（插件 dispose 时调用）。 */
  dispose(): void
}

/** 合法结论。 */
const DECISIONS: readonly ApprovalDecision[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** 拒绝理由的最大长度（落审计，防止被塞整篇文章）。 */
const MAX_REASON = 500

/**
 * 造一个 HTTP 系渠道适配器（web 与 mobile 的唯一实现）。
 *
 * ⚠ `BahError('web-empty-message')` 的码名带 `web-` 前缀，但移动端会抛同一个码：
 * 保留（改码名 = 改对外错误口径，需同批改 docs，收益为零）。
 */
export function createHttpChannelAdapter(options: HttpChannelAdapterOptions): HttpChannelAdapter {
  const pending = new Map<string, ApprovalViewLike>()

  /**
   * 归属校验（W04 会话层 + 03 用户层）。
   *
   * - `actor` 不传：沿用旧行为——适配器绑定了会话就必须与票据会话一致；
   * - `actor.sessionId`：必须与票据会话一致（与服务端会话同源）；
   * - `actor.userId` 与 `view.userId` **都存在**才比对；视图没带就跳过。
   */
  const ownedBy = (view: ApprovalViewLike, actor: TicketOwner | undefined): boolean => {
    const sessionId = actor?.sessionId ?? options.sessionId
    if (sessionId !== undefined && view.sessionId !== sessionId) return false
    if (
      actor?.userId !== undefined &&
      view.userId !== undefined &&
      actor.userId !== view.userId
    ) {
      return false
    }
    return true
  }

  return {
    id: options.id,
    capabilities: options.capabilities,

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

    decide(ticketId, body, actor) {
      const view = pending.get(ticketId)
      if (view === undefined) {
        return { ok: false, code: 'unknown-ticket', reason: `没有待应答的票据 ${ticketId}` }
      }
      if (!ownedBy(view, actor)) {
        // 404 与 403 的响应体形状一致（`{error:{code,reason}}`），不泄露"票存在但你没权限"
        return { ok: false, code: 'foreign-ticket', reason: '票据不属于当前会话' }
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

      // 打字确认（删除 / 撤销类操作）：**判定只在服务端**，前端输入框只是提示。
      // 放在 decision 校验之后、answer() 之前：不是有效结论就不该消费票据。
      const required = requiredConfirmText(view.name)
      if (required !== undefined && body.confirmText !== required) {
        return {
          ok: false,
          code: 'approval-confirm-mismatch',
          reason: `该操作需要逐字输入确认词「${required}」`,
        }
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

    async verify(ticketId, actor) {
      const view = pending.get(ticketId)
      if (view === undefined) {
        return { ok: false, code: 'unknown-ticket', reason: `没有待应答的票据 ${ticketId}` }
      }
      if (!ownedBy(view, actor)) {
        return { ok: false, code: 'foreign-ticket', reason: '票据不属于当前会话' }
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
