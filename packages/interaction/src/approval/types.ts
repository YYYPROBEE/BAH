/**
 * 审批服务的渠道无关词汇表（施工单 09 §2 / §2.1）。
 *
 * 三条纪律：
 * 1. **不依赖 `@bah/runtime`**：本包只认「票据视图 + 应答 + 挑战」这组结构，
 *    运行时的 `ApprovalInput` 在形状上与本文件的 `ApprovalInputLike` 兼容（宿主负责桥接）；
 * 2. **默认拒绝**：没有应答者、超时、非法返回、缺挑战端口——任何缺省路径都只能是
 *    `unavailable`（施工单 09 §2 表「超时 / 不可达 / 非法返回 → unavailable → 拒绝」）；
 * 3. **时间与定时全量注入**：`now` 与 `Timer` 都由调用方给，竞态与超时的先后顺序
 *    只由注入时钟决定，不依赖真实时间或 sleep（插件线 09 硬约束 7）。
 */

import type { SessionId } from '@bah/core'

import type { InteractionRecordSink } from './events.ts'

/** 审批结论（与运行时的 `ApprovalDecision` 同值集；本包不 import 运行时）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 全部合法结论（门禁用；顺序与施工单 09 §2 一致）。 */
export const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = [
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
]

/** 是否是一个合法结论（非法返回一律归一化为 `unavailable`）。 */
export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && (APPROVAL_OUTCOMES as readonly string[]).includes(value)
}

/** 强验证挑战渠道（人脸 / 短信 / U 盾）。 */
export type ChallengeChannel = 'face' | 'sms' | 'ushield'

/** 全部挑战渠道（配置校验与穷尽 switch 用）。 */
export const CHALLENGE_CHANNELS: readonly ChallengeChannel[] = ['face', 'sms', 'ushield']

/** 票据视图（运行时 `TicketRef` 的最小可见面）。 */
export interface ApprovalTicketView {
  /** 票据 ID（由管线按调用 ID 铸造）。 */
  readonly ticketId: string
  /** 参数指纹：参数变化即失效。 */
  readonly fingerprint: string
  /** 本次涉及金额（元；无金额工具缺省）。 */
  readonly amount?: number
  /** 过期时刻（epoch ms）——**审批超时与票据 TTL 同源**：它就是审批的截止时刻。 */
  readonly expiresAt: number
}

/** 审批卡片摘要（渠道按此渲染；业务逻辑不进渠道）。 */
export interface ApprovalSummary {
  /** 卡片标题（如「执行 transfer_create」）。 */
  readonly title: string
  /** 金额（元）。 */
  readonly amount?: number
  /** 生效级别（绿 / 黄 / 红）。 */
  readonly tier: string
}

/** 一次应答（渠道回复给仲裁器的结论）。 */
export interface ApprovalAnswer {
  /** 结论。 */
  readonly decision: ApprovalOutcome
  /** 拒绝 / 取消 / 不可达的理由（拒绝时必填，落审计）。 */
  readonly reason?: string
}

/**
 * `approval/request` 的输入形状（与运行时 `ApprovalInput` 结构兼容）。
 *
 * 用本地结构类型而不是 import 运行时：审批服务与运行时是两个物理包，
 * 运行时面由宿主插件做一次桥接（`packages/host/src/boot/plugins/approval.ts`）。
 */
export interface ApprovalInputLike {
  /** 管线铸造的票据。 */
  readonly ticket: ApprovalTicketView
  /** 本次调用 ID。 */
  readonly callId: string
  /** 工具名。 */
  readonly name: string
  /** 卡片摘要。 */
  readonly summary: ApprovalSummary
  /** 红级操作要求的强验证渠道；缺省 = 不需要挑战。 */
  readonly challenge?: ChallengeChannel
  /** 当前结论（默认 `unavailable` = 无人应答即拒绝）。 */
  readonly decision: ApprovalAnswer
}

/** 一次强验证的结论（Provider 的可替换接缝）。 */
export type ChallengeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** 结构化理由码（`verify-locked` / `challenge-channel-mismatch` / …）。 */
      readonly code: string
      /** 可读理由。 */
      readonly reason: string
      /** 已锁定到的时刻（仅 `verify-locked`）。 */
      readonly lockedUntil?: number
    }

/** 签发给应答者的挑战句柄。 */
export interface ChallengeView {
  /** 挑战 ID（审计与 `verify_*` 工具共用）。 */
  readonly challengeId: string
  /** 渠道。 */
  readonly channel: ChallengeChannel
  /** 执行一次强验证（由渠道 UI / 自动应答者调用；锁定等失败结构化返回）。 */
  verify(): Promise<ChallengeVerdict>
}

/** 应答回执：先到者被采纳，后到者拿到「已决」。 */
export type AnswerReceipt =
  | { readonly accepted: true }
  | {
      readonly accepted: false
      /** `already-decided`（已有结论）/ `expired`（票据已过期）/ `invalid-answer`（非法结论）。 */
      readonly code: 'already-decided' | 'expired' | 'invalid-answer'
    }

/** 应答者看到的会话视图（每个应答者一份，`answer` 绑定它自己的 id）。 */
export interface ApprovalView {
  /** 票据 ID。 */
  readonly ticketId: string
  /** 票据所属会话（W04 的归属校验：渠道必须只应答本会话的票据）。 */
  readonly sessionId: SessionId
  /** 调用 ID。 */
  readonly callId: string
  /** 工具名。 */
  readonly name: string
  /** 卡片摘要。 */
  readonly summary: ApprovalSummary
  /** 红级挑战句柄（仅红级 ask 有）。 */
  readonly challenge?: ChallengeView
  /** 请求关闭信号（超时 / 已有结论 / dispose 时 abort）。 */
  readonly signal: AbortSignal
  /** 提交应答；返回「是否被采纳」。 */
  answer(answer: ApprovalAnswer): AnswerReceipt
}

/**
 * 审批应答者（Web 弹窗 / IM 卡片 / 坐席控制台 / headless 自动应答者都实现它）。
 *
 * `attach` 只负责**登记**（挂事件监听 / 回调），必须尽快返回；
 * 真正的应答通过 `view.answer()` 异步提交——这样多渠道路由才可能「先应答者胜出」。
 * 抛错 = 该渠道不可达：本次请求归一化为 `unavailable`（默认拒绝）。
 */
export interface ApprovalResponder {
  /** 渠道 id（审计与去重报警用）。 */
  readonly id: string
  /** 登记到一次审批请求上。 */
  attach(view: ApprovalView): void | Promise<void>
}

/** 挑战签发结果。 */
export type ChallengeIssue =
  | { readonly ok: true; readonly challengeId: string }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * 强验证挑战端口（由宿主用银行侧 `VerifyService` 实现；本包只认这三个动作）。
 *
 * 为什么把签发放在审批服务而不是判定函数：签发需要会话 ID 与“这次 ask 正在等人应答”
 * 这个事实，二者都只在这里可见（施工单 09 §6 的挑战链）。
 */
export interface ChallengePort {
  /** 签发一条挑战（`VerifyService.issue` 自此有生产调用点）。 */
  issue(channel: ChallengeChannel): ChallengeIssue
  /** 提交一次验证（三连败 → 锁定由 Provider 侧判定并返回 `verify-locked`）。 */
  verify(challengeId: string, channel: ChallengeChannel): Promise<ChallengeVerdict>
  /** 挑战是否已通过（批准前的强制检查）。 */
  passed(challengeId: string): boolean
}

/** 定时器接缝（测试注入手动时钟；生产用 `systemTimer`）。 */
export interface Timer {
  /** 安排一次回调；返回取消函数（幂等）。 */
  set(callback: () => void, delayMs: number): () => void
}

/** 生产定时器（唯一使用真实时间的地方；测试不注入它）。 */
export const systemTimer: Timer = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => {
      clearTimeout(handle)
    }
  },
}

/** 一次判决的观测记录（指标 / 审计 / 测试断言用；不落会话事件）。 */
export interface SettledApproval {
  /** 调用 ID。 */
  readonly callId: string
  /** 票据 ID。 */
  readonly ticketId: string
  /** 最终结论。 */
  readonly decision: ApprovalOutcome
  /** 采纳者（应答者 id / `timeout` / `dispose` / `downstream`）。 */
  readonly by: string
  /** 从发起到判决的等待时长（ms；由注入时钟计算）。 */
  readonly waitedMs: number
}

/** `ApprovalService` 的装配参数。 */
export interface ApprovalServiceOptions {
  /** 本会话 ID（挑战事件与审计需要；宿主从 `bah:run` 注入）。 */
  readonly sessionId: SessionId
  /** 时钟（确定性注入；票据 `expiresAt` 也按它比较）。 */
  readonly now: () => number
  /** 定时器（缺省 `systemTimer`）。 */
  readonly timer?: Timer
  /** 强验证挑战端口（缺省 = 红级一律 `unavailable`：默认拒绝）。 */
  readonly challenges?: ChallengePort
  /** 审计事件出口（宿主接到 `session.append(..., { ignorable: true })`）。 */
  readonly record?: InteractionRecordSink
  /** 判决观测（可选）。 */
  readonly onSettled?: (settled: SettledApproval) => void
}
