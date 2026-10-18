/**
 * 会话事件的**唯一格式**与其耐久事件表（施工单 03 §1.1 / §1.2）。
 *
 * envelope 本身由 `@bah/core` 的 `api.ts` 冻结（阶段 1 签审），本文件只做两件事：
 * 1. 用**模块增强**把 `SessionEventMap` 从索引签名补成逐键声明（不修改冻结文件；
 *    `api.ts` 的注释本身就把「逐键声明」列为阶段 3 的扩展动作）；
 * 2. 给出运行时侧的 `SessionEventType` 联合与判别联合视图 `AnySessionEvent`，
 *    让消费方 switch 时 `event.data` 自动收窄、并以 `assertNever` 收尾（施工单 00 §9 第 6 条）。
 *
 * 族级索引 vs 领域事件：本文件只声明**平台族**（turn/step、请求、消息、工具、审批）；
 * `transfer/*`、`card/*`、`wealth/*` 等**领域事件由各自插件包用同一个增强机制追加**
 * （施工单 03 §1.2「每个工具/插件在自己的包 README 中声明其 durable 事件」）。
 */

import type { ContentBlock, SessionEvent, SessionEventMap, TicketId } from '@bah/core'

/** 当前逻辑格式版本。reader 遇到更高版本必须拒绝打开（施工单 03 §1.5）。 */
export const SESSION_FORMAT_VERSION = 1

/**
 * 平台族 durable 事件的**全量键**（`SessionEventMap` 的声明必须与本数组一一对应）。
 *
 * 顺序即「落账顺序的族级约定」，不代表强制时序；门禁 `verify-session-events`
 * 用它校验「代码里 append 的事件名是否都在表内」。
 */
export const SESSION_EVENT_TYPES = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'request/header',
  'request/context',
  'system/message',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'approval/asked',
  'approval/decided',
  'usage/summary',
  'compaction/summary',
] as const

declare module '@bah/core' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface SessionEventMap {
    /** 一个 turn 开始（`turn` 自 1 递增）。 */
    'turn/start': { turn: number }
    /** 一个 turn 结束；`reason` 是粘性结束原因（施工单 04 §2.1）。 */
    'turn/end': { turn: number; reason: TurnEndReason }
    /** 一个 step 开始（turn 内自 1 递增）。 */
    'step/start': { turn: number; step: number }
    /** 一个 step 结束。 */
    'step/end': { turn: number; step: number }
    /** 请求头：本次模型请求的路由与参数快照（冻结后不可改写）。 */
    'request/header': {
      turn: number
      step: number
      model: string
      params?: Readonly<Record<string, unknown>>
    }
    /** 请求携带的运行时上下文（`agent.inject` 的落账，模型可见）。 */
    'request/context': { turn: number; step: number; texts: readonly string[] }
    /** system 消息（提示词装配结果，模型可见）。 */
    'system/message': { content: string; section?: string }
    /** user 消息（模型可见）。 */
    'user/message': { content: string; source?: UserMessageSource }
    /** assistant 消息（模型可见；含本轮发起的工具调用）。 */
    'assistant/message': {
      content: readonly ContentBlock[]
      toolCalls?: readonly ToolCallRecord[]
    }
    /** 失败/重试/取消的沉淀（模型不可见，但必须留痕：取消就是没发生，失败要能复盘）。 */
    'assistant/attempt': { status: 'failed' | 'retried' | 'cancelled'; reason?: string }
    /** 工具调用（**执行前**落账）。 */
    'tool/call': ToolCallData
    /** 工具结果（**唯一**面向模型的结果；isError 也走这里）。 */
    'tool/result': ToolResultData
    /** 审批请求已发起（票据与调用绑定）。 */
    'approval/asked': {
      ticketId: TicketId
      callId: string
      name: string
      amount?: number
      challenge?: ApprovalChallenge
    }
    /** 审批已有结论（含 `unavailable`：无人值守直接拒绝）。 */
    'approval/decided': {
      ticketId: TicketId
      decision: ApprovalDecision
      reason?: string
      code?: string
    }
    /**
     * 一个 turn 的成本汇总（施工单 05 §3：按 turn 汇总 tokens，进审计导出）。
     *
     * 不产生模型消息，但**必须**落账——否则"资源可控"没有可出示的证据。
     */
    'usage/summary': UsageSummaryData
    /**
     * 上下文压缩摘要（施工单 05 §5：摘要本身作为会话事件落账，可回放、可审计）。
     *
     * 压缩不改写历史（append-only 是不变量）：摘要落账 + 投影时折叠，两者配合还原"当时模型看到什么"。
     */
    'compaction/summary': CompactionSummaryData
  }
}

/**
 * `user/message` 的来源。
 *
 * `runtime-context` 与 `context` 必须分开：前者是**每次 attempt 重新渲染的运行时上下文**
 * （下次装配时按 reconcile 撤回），后者是工具后置阶段追加的一次性纠正文本（要留在历史里）。
 * 混用会让"撤回旧上下文"顺手把纠正文本也撤掉（施工单 05 §4.1）。
 */
export type UserMessageSource = 'user' | 'context' | 'tool-recovery' | 'runtime-context'

/** 压缩后保留的金融结构化字段（施工单 05 §5：涉及金额/收款人/审批的条目不得只留摘要）。 */
export interface FinancialSummaryEntry {
  readonly amount: number
  readonly payee: string
  /**
   * 审批票据 ID。
   *
   * 绿色直通调用**没有票据**（不伪造编号）：此时字段缺省、`decision = 'not-required'`。
   */
  readonly ticketId?: TicketId
  readonly decision: string
}

/** `compaction/summary` 的载荷。 */
export interface CompactionSummaryData {
  /** 被折叠的首个 turn（含）。 */
  readonly fromTurn: number
  /** 被折叠的最后一个 turn（含）。 */
  readonly toTurn: number
  /** 被折叠的 turn 数。 */
  readonly turns: number
  /** 结构化摘要文本（确定性生成，不含模型调用）。 */
  readonly summary: string
  /** 被折叠事件的 `seq` 引用（审计可回跳到原文）。 */
  readonly refs: readonly number[]
  /** 金融特例字段（结构化保留）。 */
  readonly financial: readonly FinancialSummaryEntry[]
  /** 被折叠的模型可见消息条数。 */
  readonly droppedMessages: number
}

/** `usage/summary` 的载荷（与 `@bah/llm` 的 `TurnUsage` 同形）。 */
export interface UsageSummaryData {
  readonly turn: number
  readonly input: number
  readonly output: number
  readonly calls: number
}

/** turn 结束原因（施工单 04 §2.1 的粘性原因；本阶段先给闭合联合）。 */
export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'blocked' }
  | { kind: 'aborted' }
  | { kind: 'max-tokens' }
  | { kind: 'failed'; reason: string }

/** 工具体可见的调用记录（落在 `assistant/message.toolCalls` 里）。 */
export interface ToolCallRecord {
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

/** `tool/call` 的载荷：模型发起的调用 + 执行前的元数据。 */
export interface ToolCallData extends ToolCallRecord {
  /** 参数指纹：参数变化即失效（票据绑定 / 单调 guard 都靠它）。 */
  readonly fingerprint: string
  /** 定义处声明的权限级别（治理平面解释，工具自带阈值属违规）。 */
  readonly tier: { readonly level: 'green' | 'yellow' | 'red'; readonly amountPath?: string }
  /** 调用发生时刻（epoch ms）。 */
  readonly at: number
}

/** `tool/result` 的载荷：冻结的权威结果（同时是模型可见的唯一结果）。 */
export interface ToolResultData {
  readonly callId: string
  readonly name: string
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
  /** 结构化理由码（deny/block/超时/内部错误等；成功时缺省）。 */
  readonly code?: string
  readonly reason?: string
  /** 执行耗时（ms；未执行时为 0）。 */
  readonly durationMs?: number
}

/** 强验证挑战渠道（红级工具）。 */
export type ApprovalChallenge = 'face' | 'sms' | 'ushield'

/** 审批结论（施工单 04 §5 `approval/request` 的返回值）。 */
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 本包认识的会话事件类型（`SessionEventMap` 的键，收窄掉了 core 的索引签名）。 */
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number]

/**
 * 判别联合视图：`switch (event.type)` 后 `event.data` 自动收窄。
 *
 * core 的 `SessionEvent<U>` 是单接口泛型，不做判别；这里按全量键展开成联合。
 */
export type AnySessionEvent = { [K in SessionEventType]: SessionEvent<K> }[SessionEventType]

/** 本包认识的类型集合（reader 判定「未知事件」的默认白名单）。 */
export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set(SESSION_EVENT_TYPES)

/** `append` 的可选参数。 */
export interface AppendOptions {
  /** `true` 时旧 reader 可跳过该事件；缺省 = required-on-read。 */
  readonly ignorable?: boolean
}

/** 派生投影的限制项。 */
export interface DeriveOptions {
  /**
   * reader 认识的事件类型集合（默认 = 本包全量键）。
   *
   * 用子集模拟「旧 reader」：表外事件按 `ignorable` 规则处理——
   * `ignorable: true` 跳过且不报错，否则视为 required-on-read 缺失，直接抛错。
   */
  readonly known?: ReadonlySet<string>
}

/** 派生出的模型可见消息（施工单 03 §1.4）。 */
export type DerivedMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant'
      readonly content: readonly ContentBlock[]
      readonly toolCalls?: readonly ToolCallRecord[]
    }
  | {
      readonly role: 'tool'
      readonly callId: string
      readonly name: string
      readonly isError: boolean
      readonly content: readonly ContentBlock[]
    }
