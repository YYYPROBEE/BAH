/**
 * 会话服务的接缝与装配（施工单 03 §1.3 / §3 第 9 步的会话侧）。
 *
 * 唯一职责：把 append-only 存储 + `session/event` 广播 + 派生投影打包成一个按键取用的服务。
 * 管线只依赖 `SessionSink`（能 append 即可），这样工具侧不必知道存储实现。
 */

import { defineService } from '@bah/core'
import { logJson } from '@bah/util'

import type { Context, Disposer, ServiceKey, SessionEvent, SessionEventMap, SessionId } from '@bah/core'

import { deriveMessages } from './derive.ts'
import { currentSessionBuffer } from './buffer.ts'
import { SessionStore, type SessionClock } from './store.ts'
import type {
  AnySessionEvent,
  AppendOptions,
  DeriveOptions,
  DerivedMessage,
  SessionEventType,
} from './types.ts'

/** 落账面：七段管线只需要 `append` / `appendDomain`。 */
export interface SessionSink {
  append<S extends SessionEventType>(
    type: S,
    data: SessionEventMap[S],
    options?: AppendOptions,
  ): SessionEvent<S>
  /**
   * 领域事件通道（`ticket/*`、`sentry/*`、`identity/bound` 等）。
   *
   * 平台事件表之外的事件族走这里：`data` 不受编译期形状校验，但落账统一补
   * `ignorable: true`，旧 reader 跳过而不是把领域事件当成日志空洞。
   */
  appendDomain(type: string, data: unknown, options?: { readonly ignorable?: true }): AnySessionEvent
}

/** 会话服务（`runtime:session`）。 */
export interface SessionApi extends SessionSink {
  /** 本会话 ID（跨边界不透明）。 */
  readonly sessionId: SessionId
  /** 逻辑格式版本（落账用；reader 版本策略见 JSONL 后端）。 */
  readonly formatVersion: number
  /** 全量只读事件视图。 */
  events(): readonly AnySessionEvent[]
  /** 全量只读视图（内部热路径，不拷贝；调用方必须只读）。 */
  eventsView(): readonly AnySessionEvent[]
  /** 最后一条事件的 `seq`。 */
  lastSeq(): number
  /** 从日志派生模型历史（施工单 03 §1.4）。 */
  deriveMessages(options?: DeriveOptions): DerivedMessage[]
}

/** 服务键：跨包只认这个（施工单 00 §9 补充纪律「按键寻址」）。 */
export const SESSION_SERVICE: ServiceKey<SessionApi> = defineService<SessionApi>('runtime:session')

/** `provideSession` 的选项。 */
export interface ProvideSessionOptions {
  readonly sessionId: SessionId
  /** 时间戳来源（测试注入确定性时钟）。 */
  readonly now?: SessionClock
  /** 逻辑格式版本（默认 `SESSION_FORMAT_VERSION`）。 */
  readonly formatVersion?: number
  /** 复用外部存储（JSONL 回放时 `restore` 过事件的实例）。 */
  readonly store?: SessionStore
}

/**
 * 注册 `runtime:session` 服务。
 *
 * 每次 `append` 都会同步广播 `session/event`（`emitIsolated`，不阻塞）——
 * 审计、失败补偿（`ToolCallRecovery`）、UI 跟随流都挂在这个口上。
 * "同步"指**返回前一定派发完**；监听器在自己的回调里再 append 时，
 * 那条嵌套事件排到队尾、由同一层循环派发完再返回（见下）。
 *
 * 为什么是 `emitIsolated` 而不是 `emit`：落账已经成功，一个记账监听器抛错
 * 不能反过来中断落账、也不能让后面的观察者收不到这条事件。
 *
 * **广播必须按落账顺序到达每个监听器**（W18 修）：`emitIsolated` 是同步遍历，
 * 而监听器**可以在自己的回调里再 `append`**（`safety:sentry` 的 `trace.sink='session'`
 * 就是这么写 `sentry/trace` 的）。那次嵌套 `append` 会立刻重入广播，把 seq=N+1 先送给
 * 排在写者**后面**的监听器；等外层继续走到它们时，seq=N 已经"过期"。
 * 对按 seq 单调消费的监听器（`channel:web` 的投影器）就是这条事件被静默丢弃——
 * 网页收不到 `tool` / `approval` 帧，审批弹窗永不出现。
 * 因此这里用队列把嵌套事件排到队尾：一个事件派发完再派发下一个，
 * 所有监听器看到的顺序恒等于落账顺序。
 */
export function provideSession(ctx: Context, options: ProvideSessionOptions): Disposer {
  const store =
    options.store ??
    new SessionStore({ now: options.now, formatVersion: options.formatVersion })

  /** 待派发队列（重入时只入队，由最外层派发循环统一消费）。 */
  const pending: AnySessionEvent[] = []
  let draining = false

  const dispatch = (event: AnySessionEvent): void => {
    ctx.events.emitIsolated(
      'session/event',
      { session: options.sessionId, event },
      (error, name) => {
        // 隔离后只留痕：这里再 append 一条审计会递归进同一个广播口
        logJson('error', 'runtime.session-listener-failed', {
          listener: name,
          reason: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }

  const broadcast = (event: AnySessionEvent): void => {
    pending.push(event)
    // 已经在派发循环里 ⇒ 只入队；否则由本次调用把队列排空
    if (draining) return
    draining = true
    let failure: unknown
    try {
      while (pending.length > 0) {
        const next = pending.shift()
        if (next === undefined) break
        try {
          dispatch(next)
        } catch (error) {
          // `emitIsolated` 已隔离单个监听器的抛错；能到这里只剩"事件模式声明不一致"
          // 这类装配错误。继续排空队列，最后再把首个错误抛给 append 的调用方。
          failure ??= error
        }
      }
    } finally {
      pending.length = 0
      draining = false
    }
    if (failure !== undefined) throw failure
  }

  const api: SessionApi = {
    sessionId: options.sessionId,
    formatVersion: store.formatVersion,

    append<S extends SessionEventType>(
      type: S,
      data: SessionEventMap[S],
      appendOptions?: AppendOptions,
    ): SessionEvent<S> {
      const buffer = currentSessionBuffer()
      if (buffer !== undefined) {
        buffer.record((sink) => sink.append(type, data, appendOptions))
        // 缓冲期不分配真实 seq；调用方不依赖返回值（flush 时由真实 sink 分配）
        return {
          seq: 0,
          at: 0,
          formatVersion: store.formatVersion,
          type,
          data,
          ...(appendOptions?.ignorable === undefined ? {} : { ignorable: appendOptions.ignorable }),
        } as SessionEvent<S>
      }
      const event = store.append(type, data, appendOptions)
      // 存储层按键取类型，广播面统一成判别联合（`AnySessionEvent`）
      broadcast(event as AnySessionEvent)
      return event
    },

    appendDomain(type, data, appendOptions) {
      const buffer = currentSessionBuffer()
      if (buffer !== undefined) {
        buffer.record((sink) => sink.appendDomain(type, data, appendOptions))
        return {
          seq: 0,
          at: 0,
          formatVersion: store.formatVersion,
          type,
          data,
          ignorable: appendOptions?.ignorable ?? true,
        } as AnySessionEvent
      }
      const event = store.appendDomain(type, data, appendOptions)
      broadcast(event)
      return event
    },

    events: () => store.events(),
    eventsView: () => store.eventsView(),
    lastSeq: () => store.lastSeq(),
    deriveMessages: (deriveOptions) => deriveMessages(store.eventsView(), deriveOptions),
  }

  return ctx.provide(SESSION_SERVICE, api)
}
