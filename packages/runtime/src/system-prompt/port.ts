/**
 * 运行时上下文槽位端口（实体槽位的唯一注入点）。
 *
 * 三条纪律：
 * 1. 业务失败是**值**（`status` / `code`），编程错误才是异常；
 * 2. `sessionId` 来自 AgentLoop 的**当次会话**（fork 后是子会话），不是进程启动会话；
 * 3. 端口只产出"展示字符串 + 枚举 + 脱敏数字"，不产出金额 `number`。
 *
 * 依赖方向：类型放 runtime，实现由 `bank:tools` 提供，`host` 做结构兼容赋值。
 * runtime **不认识** bank——端口层不许出现任何金额格式化或核心读取逻辑。
 */

import { defineService } from '@bah/core'

import type { ServiceKey, SessionId } from '@bah/core'

import type { RuntimeContextView } from './types.ts'

/** 一次解析的输入（AgentLoop 每个 step 现造）。 */
export interface RuntimeContextInvocation {
  /** 当次会话（fork 后是子会话，不是进程启动会话）。 */
  readonly sessionId: SessionId
  /** fork 来源：子会话未绑定身份时，只允许继承父会话身份（不继承数据）。 */
  readonly forkOf?: SessionId
  readonly turn: number
  readonly step: number
  /** 该 step 的取消信号；端口应尽早返回 `degraded`/`slots-aborted`，而不是继续读核心。 */
  readonly signal: AbortSignal
  /**
   * 注入钟（**函数**，不是数值）。
   *
   * 只有 bank 路径调用一次（asOf / 窗口 / 熔断）；静态路径**不得调用**——
   * AgentLoop 每 step 取一次 `this.now()` 会让 fixedClock 多走一格，旧快照会全漂。
   */
  readonly now: () => number
}

/** 解析结果。 */
export interface RuntimeContextResolution {
  readonly view?: RuntimeContextView
  readonly status: 'ok' | 'unbound' | 'degraded'
  /** `status=degraded` 时的稳定理由码（见 00 §5.6 错误码表）。 */
  readonly code?: string
  /** 边界格式化好的时刻（+8，`YYYY-MM-DD HH:mm`）；运行时只排版。 */
  readonly asOfText?: string
}

/** 槽位数据源（由 `bank:tools` 提供，`core:agent` 懒取）。 */
export interface RuntimeContextSource {
  resolve(invocation: RuntimeContextInvocation): Promise<RuntimeContextResolution>
}

/** 服务键：跨包只认这个（懒取，不进 `inject` 图）。 */
export const RUNTIME_CONTEXT_SOURCE: ServiceKey<RuntimeContextSource> =
  defineService<RuntimeContextSource>('runtime:context-source')

/**
 * `context/slots` 域事件的载荷。
 *
 * 三条禁令：不含 PII（姓名/尾号/文本）、不含 `duration`（墙钟会让回放不确定）、
 * 不占平台事件表（只走 `appendDomain`，`ignorable: true`）。
 */
export interface ContextSlotsEventData {
  readonly source: 'bank'
  readonly status: 'ok' | 'unbound' | 'degraded'
  readonly code?: string
  /** 条数，不是内容。 */
  readonly accounts: number
  readonly transactions: number
  readonly asOfText?: string
}
