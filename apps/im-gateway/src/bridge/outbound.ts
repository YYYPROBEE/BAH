/**
 * 出站投递（施工单 02 §2.13 的能力驱动推送模式）。
 *
 * 微信的硬约束是"被动回复只在 5 秒窗口内"：模型跑不完，就不能等——必须先 ack，
 * 结果出来后走客服消息（push）。push 也可能不可用（测试号未开权限、48 小时窗口过期），
 * 那就退到**拉取式**：结果进缓存，用户发 `0` 取回。
 *
 * 三条纪律：
 * 1. **不向用户暴露 errcode**：`push` 的失败码只进日志，用户看到的是"回复 0 获取结果"；
 * 2. **不空转**：`pull` 模式根本不调 push；`asyncPush=false` 的能力位直接退化，
 *    不做"先试一次再说"的无用调用（契约测试要求能力位与行为一致）；
 * 3. **后台任务可控**：`deliverTurn` 返回 `done`，测试可 await；生产忽略它。
 */

import { outboundText, projectImOutbound, type ImOutbound, type PlatformCapabilities, type PlatformPushResult, type PlatformResponse, type PlatformReply, type WebFrame } from '@bah/channels'

import { ACK_TEXT, PULL_MAX_ITEMS, PULL_TTL_MS, type PushMode } from '../config.ts'
import type { ImLogger } from '../log.ts'

/** 一轮最多等多久结束（后台完成时用；超时就按已有帧投影）。 */
const TURN_END_WAIT_MS = 20_000

/** 拉取式缓存（每用户最多 N 条、TTL）。 */
export interface PullStore {
  put(sessionKey: string, text: string): void
  /** 取最新一条（过期视为空）。 */
  latest(sessionKey: string): string | undefined
  size(): number
}

/** 拉取缓存依赖。 */
export interface PullStoreOptions {
  readonly nowMs: () => number
  readonly maxItems?: number
  readonly ttlMs?: number
}

/**
 * 造一个拉取式缓存。
 *
 * @param options 见 {@link PullStoreOptions}
 */
export function createPullStore(options: PullStoreOptions): PullStore {
  const maxItems = options.maxItems ?? PULL_MAX_ITEMS
  const ttlMs = options.ttlMs ?? PULL_TTL_MS
  const entries = new Map<string, { text: string; at: number }[]>()
  return {
    put(sessionKey, text): void {
      const list = entries.get(sessionKey) ?? []
      list.push({ text, at: options.nowMs() })
      // 只留最近 N 条：拉取式只为"刚才那条没推出去"，不是消息历史
      entries.set(sessionKey, list.slice(-maxItems))
    },

    latest(sessionKey): string | undefined {
      const list = entries.get(sessionKey)
      if (list === undefined || list.length === 0) return undefined
      const last = list[list.length - 1]
      if (last === undefined) return undefined
      if (options.nowMs() - last.at > ttlMs) {
        entries.delete(sessionKey)
        return undefined
      }
      return last.text
    },

    size(): number {
      return entries.size
    },
  }
}

/** 一轮的帧收集器（SSE 帧进、等待原语出）。 */
export interface TurnCollector {
  push(frame: WebFrame): void
  frames(): readonly WebFrame[]
  /** 等到"出现一条助手/坐席消息"或超时。 */
  waitForMessage(ms: number): Promise<boolean>
  /** 等到"本轮结束"（`turn/end`）或超时。 */
  waitEnd(ms: number): Promise<boolean>
}

/** 是否是一条可回复的消息（用户自己的话不回发）。 */
function isAnswer(frame: WebFrame): boolean {
  return frame.kind === 'message' && frame.role !== 'user'
}

/** 是否本轮已结束。 */
function isTurnEnd(frame: WebFrame): boolean {
  return frame.kind === 'turn' && frame.phase === 'end'
}

/**
 * 造一个帧收集器。
 *
 * 单一 waiter：`deliverTurn` 串行等待（先等消息、再等结束），不需要并发等待语义。
 */
export function createTurnCollector(): TurnCollector {
  const buffer: WebFrame[] = []
  let waiter: ((value: boolean) => void) | undefined
  let timer: NodeJS.Timeout | undefined

  const settle = (value: boolean): void => {
    if (waiter === undefined) return
    const resolve = waiter
    waiter = undefined
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    resolve(value)
  }

  const wait = (predicate: (frames: readonly WebFrame[]) => boolean, ms: number): Promise<boolean> => {
    if (predicate(buffer)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      waiter = resolve
      timer = setTimeout(() => settle(false), ms)
      timer.unref()
    })
  }

  return {
    push(frame: WebFrame): void {
      buffer.push(frame)
      if (isAnswer(frame) || isTurnEnd(frame)) settle(true)
    },
    frames: () => buffer,
    waitForMessage: (ms) => wait((frames) => frames.some(isAnswer), ms),
    waitEnd: (ms) => wait((frames) => frames.some(isTurnEnd), ms),
  }
}

/** 投递依赖。 */
export interface DeliverInput {
  readonly mode: PushMode
  readonly capabilities: PlatformCapabilities
  readonly sessionKey: string
  readonly reply: PlatformReply
  readonly collector: TurnCollector
  readonly pull: PullStore
  readonly passiveWaitMs: number
  readonly log: ImLogger
}

/** 投递结果：同步响应 + 后台完成信号。 */
export interface DeliverResult {
  readonly response: PlatformResponse
  /** 后台任务（ack 之后才跑的 push / 拉取落库）；生产忽略，测试可 await。 */
  readonly done: Promise<void>
}

/** 能力位驱动的实际模式（`pull` 之外的最低能力检查）。 */
export function resolveMode(mode: PushMode, capabilities: PlatformCapabilities): PushMode {
  if (!capabilities.passiveReply) return 'push'
  if (!capabilities.asyncPush) return 'passive'
  return mode
}

/** 安全投影（半截帧/未知帧丢弃，不让它打断链路）。 */
function projectFrames(frames: readonly WebFrame[]): readonly ImOutbound[] {
  try {
    return projectImOutbound(frames)
  } catch {
    return []
  }
}

/** 把出站合并成一条可缓存文本（拉取式只存文本）。 */
function joinOutbounds(outbounds: readonly ImOutbound[]): string {
  return outbounds
    .map(outboundText)
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

/**
 * 投递一轮结果。
 *
 * 返回的 `response` 就是平台 HTTP 响应（微信被动回复 / challenge）；`done` 是后台任务。
 */
export async function deliverTurn(input: DeliverInput): Promise<DeliverResult> {
  const mode = resolveMode(input.mode, input.capabilities)
  const ack = (): PlatformResponse => input.reply.passive([{ kind: 'text', text: ACK_TEXT }])

  const finishInBackground = async (): Promise<void> => {
    const ended = await input.collector.waitEnd(TURN_END_WAIT_MS)
    if (!ended) input.log.warn('im-turn-failed', { reason: 'turn-end-timeout', sessionKey: input.sessionKey })
    const outbounds = projectFrames(input.collector.frames())
    if (outbounds.length === 0) return

    if (mode !== 'pull' && input.capabilities.asyncPush) {
      let pushed: PlatformPushResult
      try {
        pushed = await input.reply.push(outbounds)
      } catch (error) {
        pushed = { ok: false, code: 'failed', reason: error instanceof Error ? error.message : 'push-error' }
      }
      if (pushed.ok) return
      input.log.warn('im-push-failed', { sessionKey: input.sessionKey, code: pushed.code })
    }

    input.log.warn('im-push-fallback', {
      sessionKey: input.sessionKey,
      reason: mode === 'pull' ? 'pull-mode' : 'push-unavailable',
    })
    input.pull.put(input.sessionKey, joinOutbounds(outbounds))
  }

  if (mode === 'pull' || mode === 'push') {
    // 拉取式/推送式：都先 ack（推送式：结果只走 push；失败仍落拉取式）
    return { response: ack(), done: finishInBackground() }
  }

  // auto / passive：先等首个消息（最多 passiveWaitMs）；等到就一次性被动回复
  const waited = await input.collector.waitForMessage(input.passiveWaitMs)
  if (waited) {
    const outbounds = projectFrames(input.collector.frames())
    if (outbounds.length > 0) {
      return { response: input.reply.passive(outbounds), done: Promise.resolve() }
    }
  }
  // 超时（或等到的帧没有可呈现内容）：先 ack，结果交给后台 push / 拉取
  return { response: ack(), done: finishInBackground() }
}
