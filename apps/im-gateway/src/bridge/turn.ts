/**
 * 入站一轮的编排。
 *
 * 顺序（每一步都不可换）：
 * `限流 → 去重 → 文本指令 → untrusted 标记 → 确保子进程 → 订阅 SSE → POST /api/turn → 投递`。
 *
 * 为什么限流先于去重：微信的重试是**同一条消息**重复到达，让它们共享"一次"额度；
 * 反过来（去重先）会让"同一条消息刷 100 次"完全免限流。
 *
 * 为什么先订阅再 turn：turn 一入队就可能立刻产帧，先 turn 后订阅会丢掉第一条回复。
 */

import {
  deriveImSessionId,
  parseImCommand,
  prepareImInbound,
  type ImCommand,
  type ImInbound,
  type PlatformCapabilities,
  type PlatformReply,
  type PlatformResponse,
} from '@bah/channels'

import { assertNever } from '@bah/util'

import { planApprovalCommand, type ApprovalPlan } from '../approval/commands.ts'
import { mapDecideResult, mapHandoffResult, mapVerifyResult } from '../approval/submit.ts'
import {
  composeDetailMessage,
  NO_PENDING_TEXT,
  QUEUED_FOR_OPERATOR_TEXT,
  UNKNOWN_TICKET_TEXT,
} from '../approval/texts.ts'
import type { GatewayConfig } from '../config.ts'
import {
  BUSY_TEXT,
  EMPTY_PULL_TEXT,
  FAILED_TEXT,
  MAINTENANCE_TEXT,
  OFFLINE_TEXT,
  QUEUE_FULL_TEXT,
  RATE_LIMITED_TEXT,
} from '../config.ts'
import { inboundDedupeKey, type Dedupe } from '../ingress/dedupe.ts'
import type { RateLimiter } from '../ingress/ratelimit.ts'
import type { ImLogger } from '../log.ts'
import type { SessionHub } from '../session/hub.ts'
import type { ChildHandle, Supervisor } from '../session/supervisor.ts'
import { IM_HELP_TEXT, isHelpRequest } from './help.ts'
import {
  HISTORY_FAILED_TEXT,
  HISTORY_IDLE_TEXT,
  HISTORY_MAX_ITEMS,
  isHistoryRequest,
  renderHistoryText,
} from './history.ts'
import { createTurnCollector, deliverTurn, type PullStore } from './outbound.ts'

/** 等 SSE 连接建立的最长时间（超过就照常发 turn：宁可少一次流式帧，不拖过 5 秒窗口）。 */
const OPEN_WAIT_MS = 500

/** 入站处理依赖。 */
export interface InboundDeps {
  readonly config: GatewayConfig
  readonly supervisor: Supervisor
  readonly dedupe: Dedupe
  readonly rateLimiter: RateLimiter
  readonly pull: PullStore
  /** 常驻会话运行态（审批 / 接管 / 迟到回复的主动推送）。 */
  readonly hub: SessionHub
  readonly log: ImLogger
  /** 平台能力位（由注册表给的适配器取出；未知平台返回 undefined）。 */
  readonly capabilitiesOf: (platform: string, accountKey: string) => PlatformCapabilities | undefined
  /** 等 SSE 打开的超时（测试可缩短）。 */
  readonly openWaitMs?: number
}

/** 一次入站的处理结果。 */
export interface InboundOutcome {
  readonly response: PlatformResponse
  /** 后台任务（ack 之后才跑的 push / 拉取落库）。 */
  readonly done: Promise<void>
}

/** 一轮尝试的结论（`auth` 是"凭证失效，需重建子进程"的信号，不是用户可见结果）。 */
type AttemptOutcome = InboundOutcome | 'auth'

/** 纯文本被动回复。 */
function plainReply(reply: PlatformReply, text: string): PlatformResponse {
  return reply.passive([{ kind: 'text', text }])
}

/** 已无后续工作的结果。 */
function immediate(response: PlatformResponse): InboundOutcome {
  return { response, done: Promise.resolve() }
}

/** 等一个 Promise，最多 `ms`（`unref` 的定时器，不拖住进程退出）。 */
function waitAtMost(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * 处理一条平台消息。
 *
 * @param deps 见 {@link InboundDeps}
 * @param inbound 已解析的平台入站
 * @param reply 该消息的双出口（闭包持有 openid）
 */
export async function handleInbound(
  deps: InboundDeps,
  inbound: ImInbound,
  reply: PlatformReply,
): Promise<InboundOutcome> {
  const nowMs = Date.now()
  const userKey = `${inbound.platform}:${inbound.userId}`

  const rate = deps.rateLimiter.check(userKey, nowMs)
  if (!rate.ok) {
    deps.log.info('im-ratelimited', { scope: rate.scope, retryAfterSec: rate.retryAfterSec })
    return immediate(plainReply(reply, RATE_LIMITED_TEXT))
  }

  if (deps.dedupe.seen(inboundDedupeKey(inbound))) {
    deps.log.info('im-duplicate', { platform: inbound.platform })
    // 微信要求 5 秒内应答；重复消息直接 success，不再跑 turn
    return immediate(plainReply(reply, 'success'))
  }

  const capabilities = deps.capabilitiesOf(inbound.platform, inbound.accountKey)
  if (capabilities === undefined) {
    // 路由层已校验过一次；走到这里说明路由与注册表不一致（防御性，不静默）
    deps.log.warn('im-platform-unknown', { platform: inbound.platform })
    return immediate(plainReply(reply, OFFLINE_TEXT))
  }

  // 文本帮助/菜单：公众号没有按钮，这是"常用业务宫格"的文本等价物。
  // 放在指令解析之前：`?` 之类的文本不该被送去模型绕一圈才回一句菜单。
  if (isHelpRequest(inbound.text)) {
    deps.log.info('im-help', { platform: inbound.platform })
    return immediate(plainReply(reply, IM_HELP_TEXT))
  }

  // 历史概览（2026-11-02）：与帮助同级，同样先于模型。
  // 只查**已存在**的子进程（`supervisor.list()`），不用 `ensure()`——那会为了看一句话
  // 拉起一个新进程，等于用户问一嘴就开一条钱路。
  if (isHistoryRequest(inbound.text)) {
    const record = deps.supervisor
      .list()
      .find(
        (item) =>
          item.platform === inbound.platform &&
          item.userId === inbound.userId &&
          item.client !== undefined,
      )
    if (record?.client === undefined) {
      deps.log.info('im-history-idle', { platform: inbound.platform })
      return immediate(plainReply(reply, HISTORY_IDLE_TEXT))
    }
    const result = await record.client.history(HISTORY_MAX_ITEMS)
    if (result.status !== 200) {
      deps.log.warn('im-history-failed', { platform: inbound.platform, status: result.status })
      return immediate(plainReply(reply, HISTORY_FAILED_TEXT))
    }
    const listed = (result.json as { sessions?: unknown } | undefined)?.sessions
    deps.log.info('im-history', { platform: inbound.platform })
    return immediate(plainReply(reply, renderHistoryText(listed)))
  }

  // 文本指令：`0` / 审批 / 转人工先于普通消息；指令面判为"不该拦截"时照常送模型
  const command = parseImCommand(inbound.text)
  if (command !== undefined) {
    const handled = await handleCommand(deps, inbound, reply, command, capabilities)
    if (handled !== undefined) return handled
  }

  const prepared = prepareImInbound({
    platform: inbound.platform,
    userId: inbound.userId,
    text: inbound.text,
    users: deps.config.untrustedUsers,
  })
  if (prepared.untrusted) {
    deps.log.info('im-untrusted', { platform: inbound.platform, reason: prepared.reason })
  }

  let handle: ChildHandle
  try {
    handle = await deps.supervisor.ensure(inbound.platform, inbound.userId)
  } catch (error) {
    const code = error instanceof Object && 'code' in error ? String((error as { code?: unknown }).code) : ''
    deps.log.warn('im-turn-failed', {
      reason: code === '' ? 'child-start-failed' : code,
      platform: inbound.platform,
    })
    return immediate(plainReply(reply, code === 'im-children-full' ? BUSY_TEXT : OFFLINE_TEXT))
  }
  deps.supervisor.touch(handle.sessionKey)
  // 常驻订阅：审批 / 接管帧与迟到回复都由它处理；per-turn 订阅只负责本轮消息
  deps.hub.attach(handle, inbound.platform, capabilities)
  deps.hub.setReply(handle.sessionKey, reply)

  const first = await attemptTurn(deps, handle, prepared.text, reply, capabilities)
  if (first !== 'auth') return first

  // 凭证失效（子进程重启后 token 轮换）：重建**一次**，再试一次
  deps.log.warn('im-turn-failed', { sessionKey: handle.sessionKey, reason: 'auth' })
  await deps.supervisor.stop(handle.sessionKey, 'auth')
  try {
    const rebuilt = await deps.supervisor.ensure(inbound.platform, inbound.userId)
    const second = await attemptTurn(deps, rebuilt, prepared.text, reply, capabilities)
    if (second !== 'auth') return second
  } catch {
    // 重建失败与"第二次仍 auth"落到同一句用户可见文案
  }
  return immediate(plainReply(reply, FAILED_TEXT))
}

/** 跑一条指令计划（审批 / 详情 / 强验证）。 */
async function runApprovalPlan(
  deps: InboundDeps,
  sessionKey: string,
  handle: ChildHandle,
  plan: ApprovalPlan,
  reply: PlatformReply,
): Promise<InboundOutcome> {
  switch (plan.kind) {
    case 'reply':
      return immediate(plainReply(reply, plan.text))
    case 'detail': {
      const ticket = deps.hub.pendingGet(sessionKey, plan.ticketId)
      if (ticket === undefined) return immediate(plainReply(reply, UNKNOWN_TICKET_TEXT))
      deps.log.info('im-approval-command', { sessionKey, ticketId: plan.ticketId, kind: 'detail' })
      return immediate(
        plainReply(
          reply,
          composeDetailMessage(ticket, {
            sessionKey,
            linkSecret: deps.config.linkSecret,
            publicBaseUrl: deps.config.publicBaseUrl,
            nowMs: Date.now(),
          }),
        ),
      )
    }
    case 'decide': {
      deps.log.info('im-approval-command', {
        sessionKey,
        ticketId: plan.ticketId,
        kind: plan.decision === 'allowed-once' ? 'approve' : 'reject',
      })
      const result = await handle.client.decide(plan.ticketId, {
        decision: plan.decision,
        ...(plan.reason === undefined ? {} : { reason: plan.reason }),
      })
      const mapped = mapDecideResult(result, plan.decision)
      deps.log.info('im-approval-result', {
        sessionKey,
        ticketId: plan.ticketId,
        code: mapped.code ?? 'ok',
      })
      return immediate(plainReply(reply, mapped.text))
    }
    case 'verify': {
      deps.log.info('im-approval-command', { sessionKey, ticketId: plan.ticketId, kind: 'verify' })
      const result = await handle.client.verify(plan.ticketId)
      const mapped = mapVerifyResult(result)
      if (mapped.ok) deps.hub.markVerified(sessionKey, plan.ticketId)
      deps.log.info('im-approval-result', {
        sessionKey,
        ticketId: plan.ticketId,
        code: mapped.code ?? 'ok',
      })
      return immediate(plainReply(reply, mapped.text))
    }
    default:
      return assertNever(plan, 'approval-plan')
  }
}

/**
 * 文本指令面（`0` / 审批 / 转人工）。
 *
 * `undefined` = "这不是给网关的指令"，调用方按普通消息送模型。
 *
 * WHY 要有这个出口：`1`/`2` 既是审批指令，也可能是模型选择题的答案（`prompt_ask`
 * 的候选）。**没有待审批时拦截 `1`** 会让用户无法回答模型的问题——真机 D0 实测踩到
 * （转账缺收款人 → 模型问"要转给谁" → 用户回 `1` → 网关回"当前没有待审批"）。
 * 有票时审批优先；无票时一律交还给对话。
 */
async function handleCommand(
  deps: InboundDeps,
  inbound: ImInbound,
  reply: PlatformReply,
  command: ImCommand,
  capabilities: PlatformCapabilities,
): Promise<InboundOutcome | undefined> {
  const sessionKey = deriveImSessionId(inbound.platform, inbound.userId, deps.config.sessionSalt)

  if (command.kind === 'fetch-latest') {
    return immediate(plainReply(reply, deps.pull.latest(sessionKey) ?? EMPTY_PULL_TEXT))
  }

  if (command.kind === 'takeover') {
    let handle: ChildHandle
    try {
      handle = await deps.supervisor.ensure(inbound.platform, inbound.userId)
    } catch (error) {
      const code =
        error instanceof Object && 'code' in error ? String((error as { code?: unknown }).code) : ''
      return immediate(plainReply(reply, code === 'im-children-full' ? BUSY_TEXT : OFFLINE_TEXT))
    }
    deps.supervisor.touch(handle.sessionKey)
    deps.hub.attach(handle, inbound.platform, capabilities)
    deps.hub.setReply(handle.sessionKey, reply)
    deps.log.info('im-handoff-request', { sessionKey: handle.sessionKey })
    const result = await handle.client.requestHandoff(command.reason)
    // 200 即子进程已进入接管：先本地置位，避免下一条消息抢在 handoff 帧前被当普通 turn
    if (result.status === 200) deps.hub.noteHandoffRequested(handle.sessionKey)
    return immediate(plainReply(reply, mapHandoffResult(result).text))
  }

  // 没有待审批、也没点名票号 → 不是审批指令：交还给对话（可能是选择题答案）
  if (command.ticketId === undefined && deps.hub.pendingCount(sessionKey) === 0) {
    return undefined
  }

  // 审批类：只复用已就绪的会话，不为空票拉起子进程
  const record = deps.supervisor.get(sessionKey)
  if (record === undefined || record.status !== 'ready' || record.client === undefined) {
    const text = command.kind === 'approve' ? NO_PENDING_TEXT : UNKNOWN_TICKET_TEXT
    return immediate(plainReply(reply, text))
  }
  const handle: ChildHandle = { sessionKey, port: record.port, client: record.client }
  deps.supervisor.touch(sessionKey)
  deps.hub.attach(handle, inbound.platform, capabilities)
  deps.hub.setReply(sessionKey, reply)
  return runApprovalPlan(
    deps,
    sessionKey,
    handle,
    planApprovalCommand(command, deps.hub.pendingList(sessionKey)),
    reply,
  )
}

/** 跑一轮：订阅 → turn → 投递。 */
async function attemptTurn(
  deps: InboundDeps,
  handle: ChildHandle,
  text: string,
  reply: PlatformReply,
  capabilities: PlatformCapabilities,
): Promise<AttemptOutcome> {
  const collector = createTurnCollector()
  deps.hub.beginTurn(handle.sessionKey)
  let opened: (() => void) | undefined
  const openSignal = new Promise<void>((resolve) => {
    opened = resolve
  })

  let closed = false
  const closeSubscription = handle.client.subscribe({
    // 审批 / 接管 / 坐席发言由常驻订阅处理：per-turn 只收本轮助手消息，避免重复推送
    onFrame: (frame) => {
      if (frame.kind === 'approval' || frame.kind === 'approval-closed' || frame.kind === 'handoff') {
        return
      }
      if (frame.kind === 'message' && frame.role === 'operator') return
      collector.push(frame)
    },
    onOpen: () => opened?.(),
    onError: (error) => {
      deps.log.warn('im-turn-failed', {
        sessionKey: handle.sessionKey,
        reason: 'sse-error',
        detail: error instanceof Error ? error.message : 'unknown',
      })
    },
  })
  const close = (): void => {
    if (closed) return
    closed = true
    closeSubscription()
    deps.hub.endTurn(handle.sessionKey)
  }

  // 等连接建立（最多 openWaitMs）；拿不到也继续（宁可少一帧，不拖过 5 秒窗口）
  await Promise.race([openSignal, waitAtMost(deps.openWaitMs ?? OPEN_WAIT_MS)])

  const outcome = await handle.client.turn(text)
  switch (outcome.kind) {
    case 'accepted': {
      if (deps.hub.handoffActive(handle.sessionKey)) {
        // 接管期间子进程只落账不驱动：立即回"已记录"，不空等 4 秒
        close()
        return immediate(plainReply(reply, QUEUED_FOR_OPERATOR_TEXT))
      }
      const delivered = await deliverTurn({
        mode: deps.config.pushMode,
        capabilities,
        sessionKey: handle.sessionKey,
        reply,
        collector,
        pull: deps.pull,
        passiveWaitMs: deps.config.passiveWaitMs,
        log: deps.log,
      })
      return { response: delivered.response, done: delivered.done.finally(close) }
    }
    case 'inbox-full':
      deps.log.warn('im-turn-failed', { sessionKey: handle.sessionKey, reason: 'inbox-full' })
      close()
      return immediate(plainReply(reply, QUEUE_FULL_TEXT))
    case 'halted':
      deps.log.warn('im-turn-failed', { sessionKey: handle.sessionKey, reason: 'halted' })
      close()
      return immediate(plainReply(reply, MAINTENANCE_TEXT))
    case 'auth':
      close()
      return 'auth'
    default:
      deps.log.warn('im-turn-failed', { sessionKey: handle.sessionKey, reason: outcome.code })
      close()
      return immediate(plainReply(reply, FAILED_TEXT))
  }
}
