/**
 * sentry 的 durable 事件声明。
 *
 * 为什么由本包声明：03 §1.2 的规矩是「`sentry/*`、`policy/downgraded`、`guard/repeat-tool`
 * 等治理事件由各自插件包用同一个模块增强机制追加」。这里只做声明，不改冻结的 `api.ts`。
 *
 * 两条纪律：
 * 1. **全部 `ignorable: true`**：平台 reader（`deriveMessages`）
 *    不认识这些族，必须显式可跳过，否则下一条请求会把它们当 required-on-read 缺失而拒绝；
 * 2. 事件名只允许出现在本文件——`verify-session-events` 门禁会扫强化块里的字面量。
 */

import type { SessionId } from '@bah/core'

import type { RiskLevel, TraceRecord } from '../kernel/index.ts'

/** sentry 治理事件的数据表（`SessionEventMap` 的增强内容）。 */
export interface SentrySessionEventMap {
  /** 入口平面检测到风险信号（仅审计：**检测器永不阻断**）。 */
  'sentry/detected': {
    readonly turn: number
    readonly step: number
    readonly level: RiskLevel
    readonly score: number
    readonly families: readonly string[]
    readonly transforms: readonly string[]
    /** 是否带 IM 不可信来源标记。 */
    readonly untrusted: boolean
    readonly at: number
  }
  /** 控制平面拒绝了一次工具调用（唯一阻断点的落账）。 */
  'sentry/tool-denied': {
    readonly callId: string
    readonly name: string
    /** 结构化理由码（kebab-case）。 */
    readonly code: string
    readonly reason: string
    /** 命中的确定性判决段：`rules` / `budget` / `breaker` / `degraded` / `tool-limit`。 */
    readonly stage: string
    readonly at: number
  }
  /** 断路器锁存冻结（窗口拒绝数达阈值；冻结与时间无关）。 */
  'sentry/breaker-frozen': {
    readonly sessionId: SessionId
    readonly denies: number
    readonly windowSeconds: number
    /** 本次吊销的在途票据数（属主仍是 bank-core）。 */
    readonly ticketsRevoked: number
    readonly reason: string
    readonly at: number
  }
  /** 显式人工解冻（**唯一**解除路径）。 */
  'sentry/unfrozen': {
    readonly sessionId: SessionId
    readonly by: string
    readonly reason: string
    readonly at: number
  }
  /** 幻觉防护追加了纠正提示（turn-stopping 的旁路纠正）。 */
  'sentry/honesty-corrected': {
    readonly turn: number
    /**
     * `no-result`：无工具结果却陈述账户事实；
     * `numeric`：声明值与权威值不一致；
     * `action-claim`：声称"已完成 / 已转账 / 已核销"但本 turn 工具结局不支持（S-1）。
     */
    readonly kind: 'no-result' | 'numeric' | 'action-claim'
    readonly detail: string
    readonly at: number
  }
  /**
   * 判决件自身异常 → 已按 fail-closed 阻断。
   *
   * 为什么必须单独落一条：`block` 只是"结果没进模型"，运维还需要知道
   * **是核验坏了还是真的查出错**。两者的处置完全不同（前者修组件，后者查数据）。
   *
   * `message` 只留错误类型与 200 字内的消息，**不拼接工具参数 / 结果 / 用户原话**。
   */
  'sentry/verifier-failed': {
    /** 哪个判决件坏了：后置数值对账 / 收尾行动断言核验。 */
    readonly listener: 'tools/post-execute' | 'agent/turn-stopping'
    readonly code: 'verifier-unavailable'
    readonly message: string
    readonly at: number
  }
  /**
   * 审计轨迹的 durable 副本（`trace.sink=session` 时逐条落账）。
   *
   * 载荷就是 TraceLog 的原始记录（`ts` / `seq` / `kind` 等），供 的三链导出
   * 直接回放；平台 reader 不认识本族，必须 `ignorable: true`。
   */
  'sentry/trace': TraceRecord
  /** 连续非法参数超阈 → 只绿模式。 */
  'policy/downgraded': {
    readonly sessionId: SessionId
    readonly invalidArgs: number
    readonly threshold: number
    readonly at: number
  }
  /** 同 turn 工具调用数超限。 */
  'guard/repeat-tool': {
    readonly turn: number
    readonly tools: number
    readonly limit: number
    readonly at: number
  }
}

declare module '@bah/core' {
  interface SessionEventMap extends SentrySessionEventMap {}
}

/** 本包认识的治理事件类型。 */
export type SentrySessionEventType = keyof SentrySessionEventMap

/** 治理事件全量键（文档与门禁用；顺序 = 声明顺序）。 */
export const SENTRY_SESSION_EVENT_TYPES = [
  'sentry/detected',
  'sentry/tool-denied',
  'sentry/breaker-frozen',
  'sentry/unfrozen',
  'sentry/honesty-corrected',
  'sentry/verifier-failed',
  'sentry/trace',
  'policy/downgraded',
  'guard/repeat-tool',
] as const satisfies readonly SentrySessionEventType[]
