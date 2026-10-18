/**
 * 会话服务的接缝与装配（施工单 03 §1.3 / §3 第 9 步的会话侧）。
 *
 * 唯一职责：把 append-only 存储 + `session/event` 广播 + 派生投影打包成一个按键取用的服务。
 * 管线只依赖 `SessionSink`（能 append 即可），这样工具侧不必知道存储实现。
 */

import { defineService } from '@bah/core'

import type { Context, Disposer, ServiceKey, SessionEvent, SessionEventMap, SessionId } from '@bah/core'

import { deriveMessages } from './derive.ts'
import { SessionStore, type SessionClock } from './store.ts'
import type {
  AnySessionEvent,
  AppendOptions,
  DeriveOptions,
  DerivedMessage,
  SessionEventType,
} from './types.ts'

/** 落账面：七段管线只需要 `append`。 */
export interface SessionSink {
  append<S extends SessionEventType>(
    type: S,
    data: SessionEventMap[S],
    options?: AppendOptions,
  ): SessionEvent<S>
}

/** 会话服务（`runtime:session`）。 */
export interface SessionApi extends SessionSink {
  /** 本会话 ID（跨边界不透明）。 */
  readonly sessionId: SessionId
  /** 逻辑格式版本（落账用；reader 版本策略见 JSONL 后端）。 */
  readonly formatVersion: number
  /** 全量只读事件视图。 */
  events(): readonly AnySessionEvent[]
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
 * 每次 `append` 都会同步广播 `session/event`（`emit`，不阻塞）——
 * 审计、失败补偿（`ToolCallRecovery`）、UI 跟随流都挂在这个口上。
 */
export function provideSession(ctx: Context, options: ProvideSessionOptions): Disposer {
  const store =
    options.store ??
    new SessionStore({ now: options.now, formatVersion: options.formatVersion })

  const api: SessionApi = {
    sessionId: options.sessionId,
    formatVersion: store.formatVersion,

    append(type, data, appendOptions) {
      const event = store.append(type, data, appendOptions)
      // 存储层按键取类型，广播面统一成判别联合（`AnySessionEvent`）
      ctx.events.emit('session/event', { session: options.sessionId, event: event as AnySessionEvent })
      return event
    },

    events: () => store.events(),
    lastSeq: () => store.lastSeq(),
    deriveMessages: (deriveOptions) => deriveMessages(store.events(), deriveOptions),
  }

  return ctx.provide(SESSION_SERVICE, api)
}
