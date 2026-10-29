/**
 * 入站一轮的编排（施工单 02 §2.12 / §2.13）。
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
  type ImInbound,
  type PlatformCapabilities,
  type PlatformReply,
  type PlatformResponse,
} from '@bah/channels'

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
import type { ChildHandle, Supervisor } from '../session/supervisor.ts'
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

  // 文本指令：02 只接线"0 取回结果"；审批指令属 03 单，先按普通文本转发
  if (parseImCommand(inbound.text)?.kind === 'fetch-latest') {
    const sessionKey = deriveImSessionId(inbound.platform, inbound.userId, deps.config.sessionSalt)
    const latest = deps.pull.latest(sessionKey)
    return immediate(plainReply(reply, latest ?? EMPTY_PULL_TEXT))
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

/** 跑一轮：订阅 → turn → 投递。 */
async function attemptTurn(
  deps: InboundDeps,
  handle: ChildHandle,
  text: string,
  reply: PlatformReply,
  capabilities: PlatformCapabilities,
): Promise<AttemptOutcome> {
  const collector = createTurnCollector()
  let opened: (() => void) | undefined
  const openSignal = new Promise<void>((resolve) => {
    opened = resolve
  })

  let closed = false
  const closeSubscription = handle.client.subscribe({
    onFrame: (frame) => collector.push(frame),
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
  }

  // 等连接建立（最多 openWaitMs）；拿不到也继续（宁可少一帧，不拖过 5 秒窗口）
  await Promise.race([openSignal, waitAtMost(deps.openWaitMs ?? OPEN_WAIT_MS)])

  const outcome = await handle.client.turn(text)
  switch (outcome.kind) {
    case 'accepted': {
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
