/**
 * 会话运行态（施工单 03 §2.1 / §2.6 的网关侧心脏）。
 *
 * 02 的 SSE 订阅是**每轮一条**：turn 结束就断开。接管/审批需要"长期在线"的第二条订阅，
 * 否则用户在 30 秒后才批准时，首个 turn 的订阅早已关闭，最终回复与收尾帧都会丢失。
 *
 * 本模块做三件事：
 * 1. **每条会话一条常驻 SSE 订阅**：快照重建待审批与接管状态，增量帧驱动审批推送；
 * 2. **主动推送**：审批提示 / 审批收尾 / 接管三态 / 坐席发言 / 迟到回复；
 * 3. **turn 闸门**：`beginTurn/endTurn` 计数，避免常驻订阅与 per-turn 订阅把同一条助手消息
 *    推送两次（turn 进行中由 per-turn 投递负责，turn 结束后由常驻订阅补发）。
 *
 * 纪律：平台用户标识只存在于 `PlatformReply` 闭包里；本模块只持有 sessionKey。
 */

import {
  projectImOutbound,
  type PlatformCapabilities,
  type PlatformReply,
  type PlatformPushResult,
  type WebFrame,
} from '@bah/channels'

import { joinOutbounds, resolveMode, type PullStore } from '../bridge/outbound.ts'
import type { GatewayConfig } from '../config.ts'
import type { ImLogger } from '../log.ts'
import {
  applyPendingFrame,
  markVerified,
  rebuildPending,
  type PendingTicket,
} from '../approval/pending.ts'
import { closedTextOf, composeApprovalMessage } from '../approval/texts.ts'
import { findLastHandoffState, handoffTransition } from '../handoff/bridge.ts'
import type { ChildClient } from './client.ts'
import type { ChildHandle } from './supervisor.ts'

/** 一条会话的运行态。 */
interface SessionState {
  readonly sessionKey: string
  readonly platform: string
  readonly capabilities: PlatformCapabilities
  readonly client: ChildClient
  readonly port: number
  readonly pending: Map<string, PendingTicket>
  /** 最近一次入站消息的双出口（主动推送用它，闭包里是本次平台的用户 ID）。 */
  reply?: PlatformReply
  handoffActive: boolean
  /** 只表示"200 已确认进入接管"，不代表帧已到（`handoffActive()` 两者取或）。 */
  handoffRequested: boolean
  handoffOperator?: string
  /** 当前进行中的 turn 数（>0 时助手消息由 per-turn 投递负责）。 */
  activeTurns: number
  /** 已处理到的最大 `seq`（常驻订阅的快照 + 增量去重）。 */
  lastSeq: number
  /** 是否已收到首份快照（没有快照时按 0 起算）。 */
  sawSnapshot: boolean
  closeStream?: () => void
  /** 常驻订阅是否在线（断开后下一次入站重新订阅并按快照重建）。 */
  streamLive: boolean
  /** 推送串行链（保持用户看到的消息顺序）。 */
  pushChain: Promise<void>
}

/** 会话摘要（`/seat/sessions` 用；不含平台用户标识）。 */
export interface SessionSummary {
  readonly sessionKey: string
  readonly platform: string
  readonly handoffActive: boolean
  readonly pendingCount: number
}

/** 会话运行态中心。 */
export interface SessionHub {
  /** 绑定一个就绪子进程（同一子进程幂等；新子进程替换旧订阅）。 */
  attach(handle: ChildHandle, platform: string, capabilities: PlatformCapabilities): void
  /** 记录本次入站的回复出口（主动推送用）。 */
  setReply(sessionKey: string, reply: PlatformReply): void
  /** turn 开始（常驻订阅暂停助手消息推送）。 */
  beginTurn(sessionKey: string): void
  /** turn 结束（per-turn 订阅已关闭）。 */
  endTurn(sessionKey: string): void
  pendingList(sessionKey: string): readonly PendingTicket[]
  pendingGet(sessionKey: string, ticketId: string): PendingTicket | undefined
  pendingCount(sessionKey: string): number
  markVerified(sessionKey: string, ticketId: string): void
  handoffActive(sessionKey: string): boolean
  /** 转人工成功（200）后本地先置位，避免下一条消息抢在 handoff 帧前被当普通 turn。 */
  noteHandoffRequested(sessionKey: string): void
  /** 会话摘要；未 attach 的会话返回空值。 */
  summaryOf(sessionKey: string, platform: string): SessionSummary
  /** 子进程被停止时清掉运行态。 */
  detach(sessionKey: string): void
  /** 等待所有主动推送链排空（关停 / 测试用）。 */
  flush(): Promise<void>
  /** 停全部订阅（进程退出）。 */
  dispose(): void
}

/** 中心依赖。 */
export interface SessionHubDeps {
  readonly config: GatewayConfig
  readonly log: ImLogger
  readonly pull: PullStore
  readonly nowMs?: () => number
}

/** 推送一次出站（能力/模式驱动；失败落拉取式）。 */
async function pushOutbounds(
  deps: SessionHubDeps,
  state: SessionState,
  outbounds: ReturnType<typeof projectImOutbound>,
): Promise<void> {
  if (outbounds.length === 0 || state.reply === undefined) return
  const mode = resolveMode(deps.config.pushMode, state.capabilities)
  if (mode === 'pull' || !state.capabilities.asyncPush) {
    deps.pull.put(state.sessionKey, joinOutbounds(outbounds))
    deps.log.warn('im-push-fallback', {
      sessionKey: state.sessionKey,
      reason: mode === 'pull' ? 'pull-mode' : 'push-unavailable',
    })
    return
  }
  let result: PlatformPushResult
  try {
    result = await state.reply.push(outbounds)
  } catch (error) {
    result = {
      ok: false,
      code: 'failed',
      reason: error instanceof Error ? error.message : 'push-error',
    }
  }
  if (result.ok) return
  deps.log.warn('im-push-failed', { sessionKey: state.sessionKey, code: result.code })
  deps.pull.put(state.sessionKey, joinOutbounds(outbounds))
  deps.log.warn('im-push-fallback', { sessionKey: state.sessionKey, reason: 'push-failed' })
}

/** 串行入队一次主动推送（失败不打断链）。 */
function enqueue(
  deps: SessionHubDeps,
  state: SessionState,
  outbounds: ReturnType<typeof projectImOutbound>,
): void {
  state.pushChain = state.pushChain
    .then(() => pushOutbounds(deps, state, outbounds))
    .catch((error: unknown) => {
      deps.log.warn('im-turn-failed', {
        sessionKey: state.sessionKey,
        reason: 'push-chain-failed',
        detail: error instanceof Error ? error.message : 'unknown',
      })
    })
}

/** 快照 → 运行态（不推送）。 */
function applySnapshot(deps: SessionHubDeps, state: SessionState, frame: WebFrame): void {
  if (frame.kind !== 'snapshot') return
  state.sawSnapshot = true
  state.lastSeq = Math.max(state.lastSeq, frame.maxSeq)
  const rebuilt = rebuildPending(frame.frames)
  state.pending.clear()
  for (const [ticketId, ticket] of rebuilt) state.pending.set(ticketId, ticket)
  // 接管状态以快照中最后一条 handoff 帧为准（`frameKey='handoff'` 只会留一条）
  const handoff = findLastHandoffState(frame.frames)
  if (handoff !== undefined) {
    state.handoffActive = handoff.active
    state.handoffRequested = false
    state.handoffOperator = handoff.operator
  }
  deps.log.info('im-child-ready', {
    sessionKey: state.sessionKey,
    reason: 'snapshot-rebuilt',
    pending: state.pending.size,
  })
}

/** 一条增量帧（快照已排除）。 */
function applyIncremental(deps: SessionHubDeps, state: SessionState, frame: WebFrame): void {
  if (frame.kind === 'delta' || frame.kind === 'snapshot') return
  if (typeof frame.seq === 'number') {
    // 快照覆盖到 `maxSeq`；连接建立瞬间的并发帧可能既在快照里又来一次
    if (state.sawSnapshot && frame.seq <= state.lastSeq) return
    state.lastSeq = Math.max(state.lastSeq, frame.seq)
  }

  const change = applyPendingFrame(state.pending, frame)
  if (change?.kind === 'added') {
    const text = composeApprovalMessage(change.ticket, {
      sessionKey: state.sessionKey,
      linkSecret: deps.config.linkSecret,
      publicBaseUrl: deps.config.publicBaseUrl,
      nowMs: deps.nowMs?.() ?? Date.now(),
    })
    enqueue(deps, state, [{ kind: 'text', text }])
  }
  if (change?.kind === 'closed') {
    enqueue(deps, state, [{ kind: 'text', text: closedTextOf(change.frame) }])
    if (change.frame.decision === 'unavailable') {
      deps.log.info('im-approval-expired', {
        sessionKey: state.sessionKey,
        ticketId: change.ticketId,
        code: change.frame.code ?? 'unavailable',
      })
    }
    return
  }

  if (frame.kind === 'handoff') {
    const transition = handoffTransition(
      { active: state.handoffActive, ...(state.handoffOperator === undefined ? {} : { operator: state.handoffOperator }) },
      frame,
    )
    if (transition === undefined) return
    state.handoffActive = transition.state.active
    state.handoffRequested = false
    state.handoffOperator = transition.state.operator
    enqueue(deps, state, [{ kind: 'text', text: transition.text }])
    return
  }

  // 坐席发言必须立刻到用户（turn 是否在跑无关）
  if (frame.kind === 'message' && frame.role === 'operator') {
    enqueue(deps, state, projectImOutbound([frame]))
    return
  }

  // 助手消息 / 告警：turn 进行中由 per-turn 投递负责，结束后由这里补发
  if (state.activeTurns > 0) return
  if (frame.kind === 'message' && frame.role !== 'user') {
    enqueue(deps, state, projectImOutbound([frame]))
    return
  }
  if (frame.kind === 'notice' && (frame.level === 'warning' || frame.level === 'danger')) {
    enqueue(deps, state, projectImOutbound([frame]))
  }
}

/**
 * 造一个会话运行态中心。
 *
 * @param deps 见 {@link SessionHubDeps}
 */
export function createSessionHub(deps: SessionHubDeps): SessionHub {
  const sessions = new Map<string, SessionState>()

  const makeState = (
    handle: ChildHandle,
    platform: string,
    capabilities: PlatformCapabilities,
  ): SessionState => ({
    sessionKey: handle.sessionKey,
    platform,
    capabilities,
    client: handle.client,
    port: handle.port,
    pending: new Map<string, PendingTicket>(),
    handoffActive: false,
    handoffRequested: false,
    activeTurns: 0,
    lastSeq: 0,
    sawSnapshot: false,
    streamLive: false,
    pushChain: Promise.resolve(),
  })

  const subscribe = (state: SessionState): void => {
    try {
      state.closeStream = state.client.subscribe({
        onOpen: () => {
          state.streamLive = true
        },
        onFrame: (frame) => {
          if (frame.kind === 'snapshot') {
            applySnapshot(deps, state, frame)
            return
          }
          applyIncremental(deps, state, frame)
        },
        onError: (error) => {
          state.streamLive = false
          state.closeStream?.()
          state.closeStream = undefined
          deps.log.warn('im-turn-failed', {
            sessionKey: state.sessionKey,
            reason: 'stream-error',
            detail: error instanceof Error ? error.message : 'unknown',
          })
        },
      })
    } catch (error) {
      deps.log.warn('im-turn-failed', {
        sessionKey: state.sessionKey,
        reason: 'stream-subscribe-failed',
        detail: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  return {
    attach(handle, platform, capabilities): void {
      const existing = sessions.get(handle.sessionKey)
      if (
        existing !== undefined &&
        existing.port === handle.port &&
        existing.client === handle.client
      ) {
        if (existing.streamLive) return
        // 断线后下一次入站重新订阅；快照会把待审批与接管状态重建
        existing.closeStream?.()
        existing.closeStream = undefined
        subscribe(existing)
        return
      }
      if (existing !== undefined) {
        existing.closeStream?.()
        sessions.delete(handle.sessionKey)
      }
      const state = makeState(handle, platform, capabilities)
      sessions.set(handle.sessionKey, state)
      subscribe(state)
    },

    setReply(sessionKey, reply): void {
      const state = sessions.get(sessionKey)
      if (state !== undefined) state.reply = reply
    },

    beginTurn(sessionKey): void {
      const state = sessions.get(sessionKey)
      if (state !== undefined) state.activeTurns += 1
    },

    endTurn(sessionKey): void {
      const state = sessions.get(sessionKey)
      if (state !== undefined) state.activeTurns = Math.max(0, state.activeTurns - 1)
    },

    pendingList(sessionKey): readonly PendingTicket[] {
      return [...(sessions.get(sessionKey)?.pending.values() ?? [])]
    },

    pendingGet(sessionKey, ticketId): PendingTicket | undefined {
      return sessions.get(sessionKey)?.pending.get(ticketId)
    },

    pendingCount(sessionKey): number {
      return sessions.get(sessionKey)?.pending.size ?? 0
    },

    markVerified(sessionKey, ticketId): void {
      const state = sessions.get(sessionKey)
      if (state !== undefined) markVerified(state.pending, ticketId)
    },

    handoffActive(sessionKey): boolean {
      const state = sessions.get(sessionKey)
      return state === undefined ? false : state.handoffActive || state.handoffRequested
    },

    noteHandoffRequested(sessionKey): void {
      const state = sessions.get(sessionKey)
      if (state !== undefined) state.handoffRequested = true
    },

    summaryOf(sessionKey, platform): SessionSummary {
      const state = sessions.get(sessionKey)
      return {
        sessionKey,
        platform: state?.platform ?? platform,
        handoffActive: state === undefined ? false : state.handoffActive || state.handoffRequested,
        pendingCount: state?.pending.size ?? 0,
      }
    },

    detach(sessionKey): void {
      const state = sessions.get(sessionKey)
      if (state === undefined) return
      state.closeStream?.()
      sessions.delete(sessionKey)
    },

    async flush(): Promise<void> {
      await Promise.all([...sessions.values()].map((state) => state.pushChain))
    },

    dispose(): void {
      for (const state of sessions.values()) state.closeStream?.()
      sessions.clear()
    },
  }
}
