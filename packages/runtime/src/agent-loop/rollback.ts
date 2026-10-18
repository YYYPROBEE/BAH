/**
 * 回退分叉：以会话日志为唯一真相，在 turn 边界分叉新会话（施工单 04 §3「回退」）。
 *
 * 语义三条：
 * 1. **原会话只读**：分叉不改写原日志一个字节——它是审计与回放的锚点；
 * 2. **种子 = 前缀**：新会话拿到 `seq` 连续的日志前缀（到指定 turn 的 `turn/end` 为止），
 *    `restore` 会校验连续性（断代即抛，施工单 03 §1.3）；
 * 3. **分叉元数据**：`{ parentSession, seedLength }` 由 `ForkInfo` 暴露给宿主
 *    （`agents.create({ sessionId, seed, meta: { parentSession, seedLength } })` 的
 *    `meta` 部分；`SessionApi` 上没有 meta 字段，故由 agent 侧持有）。
 *
 * 为什么新会话需要一个**新的 Context**：`runtime:session` 是服务键，一个应用只承载一个会话
 * （施工单 03 的会话服务就是按会话装配的）。分叉 = 新会话 = 新宿主上下文，
 * 这样 `provideSession` 不会与父会话的服务键冲突。多渠道 / 多会话共存的收敛方式
 * 属阶段 6 的 profile 组合，不在本阶段展开。
 */

import { BahError } from '@bah/util'

import type { Context, SessionId } from '@bah/core'

import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import { SessionStore, type SessionClock } from '../session/store.ts'
import type { AnySessionEvent } from '../session/types.ts'

/** 分叉来源（挂在分叉出来的 agent 上，供审计与 UI 展示"从哪一轮回退"）。 */
export interface ForkInfo {
  readonly parentSession: SessionId
  /** 种子事件条数（= 新会话的 `lastSeq()` 初值）。 */
  readonly seedLength: number
  /** 分叉边界（原会话的第几个 turn 结束处）。 */
  readonly turn: number
}

/** `fork` 的请求。 */
export interface ForkRequest {
  /** 新会话 ID（跨边界不透明）。 */
  readonly sessionId: SessionId
  /** 分叉边界：该 turn 的 `turn/end` 必须已经落账。 */
  readonly turn: number
  /** 新会话的宿主上下文（`runtime:session` 注册在这里）。 */
  readonly ctx: Context
  /** 时间戳来源（测试注入确定性时钟）。 */
  readonly now?: SessionClock
}

/** 一次分叉的结果。 */
export interface SessionFork {
  /** 新会话服务（种子已恢复，`seq` 连续）。 */
  readonly session: SessionApi
  readonly parentSession: SessionId
  readonly seedLength: number
  readonly seed: readonly AnySessionEvent[]
  readonly turn: number
}

/**
 * 取到指定 turn 结束为止的日志前缀。
 *
 * @throws `BahError('fork-turn-missing')` 该 turn 尚未完整结束（没有 `turn/end`）
 */
export function seedUpTo(
  events: readonly AnySessionEvent[],
  turn: number,
): readonly AnySessionEvent[] {
  const end = events.find((event) => event.type === 'turn/end' && event.data.turn === turn)
  if (end === undefined) {
    throw new BahError(
      'fork-turn-missing',
      `agent-loop: 回退失败——turn ${turn} 尚未完整结束（没有 turn/end），不能作为分叉边界`,
      { turn },
    )
  }
  return events.filter((event) => event.seq <= end.seq)
}

/**
 * 在指定 turn 边界分叉新会话。
 *
 * @throws `BahError('fork-turn-missing')` 边界 turn 未完成
 * @throws `BahError('session-seq-gap')` 原日志本身断代（`restore` 校验）
 */
export function forkSession(source: SessionApi, request: ForkRequest): SessionFork {
  const seed = seedUpTo(source.events(), request.turn)
  const store = new SessionStore({ now: request.now })
  store.restore(seed)
  provideSession(request.ctx, {
    sessionId: request.sessionId,
    store,
    ...(request.now === undefined ? {} : { now: request.now }),
  })

  return {
    session: request.ctx.get(SESSION_SERVICE),
    parentSession: source.sessionId,
    seedLength: seed.length,
    seed,
    turn: request.turn,
  }
}
