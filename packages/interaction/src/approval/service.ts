/**
 * 审批服务（施工单 09 §2）：应答者仲裁 + 超时 + 归一化 + 幂等。
 *
 * 挂在七段管线的 ③e `approval/request`（waterfall）上，是**唯一的审批判决点**：
 *
 * ```text
 * 管线签票据 → approval/asked → approval/request
 *    → [本服务] 下游先说话 → 挑战签发 → 应答者竞答 / 超时 / 取消
 *    → 归一化 allowed-once | rejected | cancelled | unavailable
 *    → 管线落 approval/decided（拒绝一律 deny）
 * ```
 *
 * 为什么不给每个渠道各注册一个 waterfall 监听：waterfall 是**串行**的，
 * 先注册的慢渠道会把后注册的渠道堵死，做不到「任意渠道先应答者胜出」。
 * 所以本服务独占一个监听，渠道以 `ApprovalResponder` 注册进来由它仲裁；
 * 对外契约仍是同一个 `approval/request` 挂点（宿主插件负责接线）。
 */

import { BahError } from '@bah/util'
import { defineService, describeThrown } from '@bah/core'

import type { Disposer, ServiceKey } from '@bah/core'

import type { InteractionRecordSink } from './events.ts'
import type {
  AnswerReceipt,
  ApprovalAnswer,
  ApprovalInputLike,
  ApprovalResponder,
  ApprovalServiceOptions,
  ApprovalView,
  ChallengeChannel,
  ChallengeIssue,
  ChallengePort,
  ChallengeView,
  SettledApproval,
  Timer,
} from './types.ts'
import { isApprovalOutcome, systemTimer } from './types.ts'

/** 一次待裁决的审批（`dispose()` 用它取消全部在途请求）。 */
interface PendingApproval {
  readonly cancel: () => void
}

/**
 * 服务键：`interaction:approval`（渠道插件按需取用来注册应答者）。
 *
 * 施工单 10 落地后，sentry 平面若要观察/接管判决，也从这个键取同一个仲裁器。
 */
export const APPROVAL_SERVICE: ServiceKey<ApprovalService> = defineService<ApprovalService>(
  'interaction:approval',
)

/** 挑战签发结果（成功带视图，失败带理由码）。 */
type IssuedChallenge = { readonly view: ChallengeView } | { readonly failure: string }

/**
 * 审批服务（渠道无关；不读运行时、不写会话日志——只通过注入的 `record` 报账）。
 *
 * 线程模型：单线程事件循环内的「先到者胜出」由**同步结算标志**保证——
 * `finish()` 一旦置位，后到的 `answer()` 只能拿到 `already-decided`。
 */
export class ApprovalService {
  private readonly sessionId: ApprovalServiceOptions['sessionId']
  private readonly now: () => number
  private readonly timer: Timer
  private readonly challenges: ChallengePort | undefined
  private readonly record: InteractionRecordSink | undefined
  private readonly onSettled: ((settled: SettledApproval) => void) | undefined
  private readonly responders = new Map<string, ApprovalResponder>()
  private readonly pending = new Map<string, PendingApproval>()
  /** dispose 之后到达的请求一律立即取消（不能再进仲裁等 TTL）。 */
  private disposed = false

  constructor(options: ApprovalServiceOptions) {
    this.sessionId = options.sessionId
    this.now = options.now
    this.timer = options.timer ?? systemTimer
    this.challenges = options.challenges
    this.record = options.record
    this.onSettled = options.onSettled
  }

  /** 已注册应答者数（0 = `unavailable` 立即拒绝，不空等 TTL）。 */
  get responderCount(): number {
    return this.responders.size
  }

  /** 在途审批数（运维 / 用例观察用）。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * 注册应答者（Web 弹窗 / IM 卡片 / 坐席 / headless 自动应答者）。
   *
   * @throws `BahError('approval-responder-duplicate')` 同一渠道 id 重复注册
   */
  attach(responder: ApprovalResponder): Disposer {
    if (this.responders.has(responder.id)) {
      throw new BahError(
        'approval-responder-duplicate',
        `interaction: 应答者 ${responder.id} 已注册（渠道 id 必须唯一）`,
        { id: responder.id },
      )
    }
    this.responders.set(responder.id, responder)
    return () => {
      if (this.responders.get(responder.id) === responder) this.responders.delete(responder.id)
    }
  }

  /**
   * `approval/request` 监听器本体。
   *
   * @param input 管线装配的请求（含票据与挑战渠道）
   * @param next waterfall 的下游（先交还控制权：下游若已裁决，以它为准）
   */
  async handle<T extends ApprovalInputLike>(input: T, next: (value: T) => Promise<T>): Promise<T> {
    // dispose 与 `await next()` 并发时，请求不能变成无人结算的孤儿
    if (this.disposed) {
      return this.settleNow(input, { decision: 'cancelled', reason: 'approval-cancelled' }, 'dispose')
    }
    const challenge = this.issueChallenge(input)
    if (challenge !== undefined && 'failure' in challenge) {
      return this.settleNow(input, { decision: 'unavailable', reason: challenge.failure }, 'challenge')
    }
    const issued = challenge?.view

    let downstream: T
    try {
      downstream = await next(input)
    } catch (error) {
      // 不吞原始异常：审批失败的原因必须能进审计（否则排障只剩四个字）
      return this.settleNow(
        input,
        { decision: 'unavailable', reason: `approval-request-failed: ${describeThrown(error)}` },
        'downstream',
      )
    }
    if (this.disposed) {
      return this.settleNow(input, { decision: 'cancelled', reason: 'approval-cancelled' }, 'dispose')
    }

    if (downstream.decision.decision !== 'unavailable') {
      // 下游（如 sentry 归一化或同步渠道）已有结论：红级仍必须验过挑战才允许放行
      if (
        downstream.decision.decision === 'allowed-once' &&
        issued !== undefined &&
        !this.passed(issued)
      ) {
        this.recordChallengeFailed(input, issued, 'challenge-required')
        return this.settleNow(input, { decision: 'rejected', reason: 'challenge-required' }, 'challenge')
      }
      return downstream
    }

    // 默认拒绝：没有应答者就没有「等满 TTL 再拒」的意义
    if (this.responders.size === 0) {
      return this.settleNow(input, { decision: 'unavailable', reason: 'approval-no-responder' }, 'no-responder')
    }

    return this.arbitrate(input, issued)
  }

  /**
   * 取消全部在途审批（dispose / 会话关闭）。
   *
   * 在途请求一律归一化为 `cancelled`（默认拒绝方向），绝不放行。
   */
  dispose(): void {
    this.disposed = true
    for (const pending of [...this.pending.values()]) pending.cancel()
  }

  /** 仲裁：应答者竞答 vs 票据 TTL 超时。 */
  private arbitrate<T extends ApprovalInputLike>(
    input: T,
    challenge: ChallengeView | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const startedAt = this.now()
      const controller = new AbortController()
      let settled = false
      let cancelTimer: () => void = () => {}

      const finish = (answer: ApprovalAnswer, by: string): boolean => {
        if (settled) return false
        settled = true
        cancelTimer()
        this.pending.delete(input.callId)
        controller.abort()
        this.onSettled?.({
          callId: input.callId,
          ticketId: input.ticket.ticketId,
          decision: answer.decision,
          by,
          waitedMs: this.now() - startedAt,
        })
        resolve({ ...input, decision: answer })
        return true
      }

      this.pending.set(input.callId, {
        cancel: () => {
          finish({ decision: 'cancelled', reason: 'approval-cancelled' }, 'dispose')
        },
      })

      const remaining = input.ticket.expiresAt - this.now()
      if (remaining <= 0) {
        // 票据先过期：此时已经没有可批准的票据，直接按「不可用」拒绝
        finish({ decision: 'unavailable', reason: 'ticket-expired' }, 'expired')
        return
      }

      cancelTimer = this.timer.set(() => {
        if (settled) return
        const at = this.now()
        this.record?.({
          type: 'approval/timeout',
          data: {
            ticketId: input.ticket.ticketId,
            callId: input.callId,
            waitedMs: Math.max(0, at - startedAt),
            at,
          },
        })
        finish({ decision: 'unavailable', reason: 'approval-timeout' }, 'timeout')
      }, remaining)

      const answer = (by: string, reply: ApprovalAnswer): AnswerReceipt => {
        if (settled) {
          this.recordDuplicate(input, by, reply.decision)
          return { accepted: false, code: 'already-decided' }
        }
        if (!isApprovalOutcome(reply.decision)) {
          finish({ decision: 'unavailable', reason: 'approval-invalid-answer' }, by)
          return { accepted: false, code: 'invalid-answer' }
        }
        if (this.now() >= input.ticket.expiresAt) {
          // TTL 先于审批超时：票据已死，任何"批准"都不成立
          finish({ decision: 'unavailable', reason: 'ticket-expired' }, by)
          return { accepted: false, code: 'expired' }
        }
        if (reply.decision === 'allowed-once' && challenge !== undefined && !this.passed(challenge)) {
          this.recordChallengeFailed(input, challenge, 'challenge-required')
          finish({ decision: 'rejected', reason: 'challenge-required' }, by)
          return { accepted: true }
        }
        finish(
          {
            decision: reply.decision,
            ...(reply.reason === undefined ? {} : { reason: reply.reason }),
          },
          by,
        )
        return { accepted: true }
      }

      for (const responder of [...this.responders.values()]) {
        const view = this.viewFor(responder, input, challenge, controller.signal, answer)
        try {
          const attached = responder.attach(view)
          void Promise.resolve(attached).catch((error: unknown) => {
            finish(
              {
                decision: 'unavailable',
                reason: `approval-responder-error: ${describeThrown(error)}`,
              },
              responder.id,
            )
          })
        } catch (error) {
          finish(
            {
              decision: 'unavailable',
              reason: `approval-responder-error: ${describeThrown(error)}`,
            },
            responder.id,
          )
        }
      }
    })
  }

  /** 每个应答者一份视图：`answer` 绑定它自己的渠道 id（重复应答报警要指名道姓）。 */
  private viewFor(
    responder: ApprovalResponder,
    input: ApprovalInputLike,
    challenge: ChallengeView | undefined,
    signal: AbortSignal,
    answer: (by: string, reply: ApprovalAnswer) => AnswerReceipt,
  ): ApprovalView {
    return {
      ticketId: input.ticket.ticketId,
      callId: input.callId,
      name: input.name,
      summary: input.summary,
      ...(challenge === undefined ? {} : { challenge }),
      signal,
      answer: (reply) => answer(responder.id, reply),
    }
  }

  /** 签发红级挑战（只有 `ask + challenge` 才需要；失败即 `unavailable`）。 */
  private issueChallenge(input: ApprovalInputLike): IssuedChallenge | undefined {
    const channel: ChallengeChannel | undefined = input.challenge
    if (channel === undefined) return undefined
    const port = this.challenges
    if (port === undefined) {
      return { failure: 'challenge-unavailable' }
    }
    const issued: ChallengeIssue = port.issue(channel)
    if (!issued.ok) return { failure: issued.code }
    const at = this.now()
    this.record?.({
      type: 'approval/challenge-issued',
      data: {
        ticketId: input.ticket.ticketId,
        callId: input.callId,
        challengeId: issued.challengeId,
        channel,
        sessionId: this.sessionId,
        at,
      },
    })
    return {
      view: {
        challengeId: issued.challengeId,
        channel,
        verify: () => port.verify(issued.challengeId, channel),
      },
    }
  }

  /** 挑战是否已通过（没有端口 = 永远不通过：默认拒绝）。 */
  private passed(challenge: ChallengeView): boolean {
    return this.challenges?.passed(challenge.challengeId) ?? false
  }

  /** 立即结算（不进入仲裁：挑战不可用 / 无应答者 / 下游已裁决但验不过）。 */
  private settleNow<T extends ApprovalInputLike>(input: T, answer: ApprovalAnswer, by: string): T {
    this.onSettled?.({
      callId: input.callId,
      ticketId: input.ticket.ticketId,
      decision: answer.decision,
      by,
      waitedMs: 0,
    })
    return { ...input, decision: answer }
  }

  /** 后到应答落审计（报警但不重复执行）。 */
  private recordDuplicate(input: ApprovalInputLike, responder: string, decision: string): void {
    this.record?.({
      type: 'approval/duplicate',
      data: {
        ticketId: input.ticket.ticketId,
        callId: input.callId,
        responder,
        decision,
        at: this.now(),
      },
    })
  }

  /** 强验证未通过落审计。 */
  private recordChallengeFailed(
    input: ApprovalInputLike,
    challenge: ChallengeView,
    code: string,
  ): void {
    this.record?.({
      type: 'approval/challenge-failed',
      data: {
        ticketId: input.ticket.ticketId,
        callId: input.callId,
        challengeId: challenge.challengeId,
        code,
        at: this.now(),
      },
    })
  }
}
