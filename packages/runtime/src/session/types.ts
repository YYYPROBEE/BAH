/**
 * 会话事件的**唯一格式**与其耐久事件表。
 *
 * envelope 本身由 `@bah/core` 的 `api.ts` 冻结（阶段 1 签审），本文件只做两件事：
 * 1. 用**模块增强**把 `SessionEventMap` 从索引签名补成逐键声明（不修改冻结文件；
 *    `api.ts` 的注释本身就把「逐键声明」列为阶段 3 的扩展动作）；
 * 2. 给出运行时侧的 `SessionEventType` 联合与判别联合视图 `AnySessionEvent`，
 *    让消费方 switch 时 `event.data` 自动收窄、并以 `assertNever` 收尾。
 *
 * 族级索引 vs 领域事件：本文件只声明**平台族**（turn/step、请求、消息、工具、审批）；
 * `transfer/*`、`card/*`、`wealth/*` 等**领域事件由各自插件包用同一个增强机制追加**
 * 。
 */

import type { ContentBlock, SessionEvent, SessionEventMap, TicketDetail, TicketId } from '@bah/core'

/** 当前逻辑格式版本。reader 遇到更高版本必须拒绝打开。 */
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
  'tool/callback-failed',
  'approval/asked',
  'approval/decided',
  'safety/assertion',
  'usage/summary',
  'compaction/summary',
] as const

declare module '@bah/core' {
  interface SessionEventMap {
    /** 一个 turn 开始（`turn` 自 1 递增）。 */
    'turn/start': { turn: number }
    /** 一个 turn 结束；`reason` 是粘性结束原因。 */
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
    /** 失败/重试/取消的沉淀（模型不可，但必须留痕：取消就是没发生，失败要能复盘）。 */
    'assistant/attempt': { status: 'failed' | 'retried' | 'cancelled'; reason?: string }
    /** 工具调用（**执行前**落账）。 */
    'tool/call': ToolCallData
    /** 工具结果（**唯一**面向模型的结果；isError 也走这里）。 */
    'tool/result': ToolResultData
    /**
     * 工具回调失败（presenter / projector / post-execute 等边界内抛错）。
     *
     * 权威结果仍然照常落账；这里只记录“某个纯函数/监听器坏了”，供审计与修复定位。
     */
    'tool/callback-failed': {
      /** 出错的阶段：present-call / project-content / post-execute / finalize-content / present-result / emit-result。 */
      readonly stage: string
      readonly callId: string
      /** 失败理由码（`BahError.code` 优先，否则 `tool-failed`）。 */
      readonly code: string
      readonly reason: string
      readonly at: number
    }
    /** 审批请求已发起（票据与调用绑定）。 */
    'approval/asked': {
      ticketId: TicketId
      callId: string
      name: string
      amount?: number
      challenge?: ApprovalChallenge
      /**
       * 票据 TTL 截止时刻（epoch ms）。
       *
       * 与 `ApprovalFrame.expiresAt` 同一份事实：签票时算一次、事件原样落账、
       * 投影原样透传。渠道只做视觉倒计时，不重算也不据此提交任何结论。
       */
      expiresAt?: number
      /**
       * 服务端签发的结构化操作明细（**可选、只展示**）。
       *
       * 由治理面随 `TicketDraft.details` 一起给出；落账后渠道只做原样投影。
       * 不参与指纹，也不参与任何判定——回放时要能回答「用户当时看到了什么」。
       */
      details?: readonly TicketDetail[]
    }
    /** 审批已有结论（含 `unavailable`：无人值守直接拒绝）。 */
    'approval/decided': {
      ticketId: TicketId
      decision: ApprovalDecision
      reason?: string
      code?: string
      /**
       * 采纳者（ADR-0010；`window-responder` = 授权窗口代签）。
       *
       * **只在窗口代签时出现**：人工票据的签署人由渠道自己记，多一个字段会让
       * 历史日志与全部快照抖动。它只追加，不改既有字段，属载荷扩展而非改签。
       */
      by?: string
    }
    /**
     * 断言核验门的一次判决（W05；载荷与事件表 v1.0.1 逐字一致）。
     *
     * 四个计数必须满足 `verified + needsEvidence + rejected = total`（门禁用例钉住）。
     * 这是"拦截与否"的可审计证据：日志里记的是最终事实，模型原话不单独留。
     */
    'safety/assertion': {
      readonly planId?: string
      readonly turnId: string
      readonly total: number
      readonly verified: number
      readonly needsEvidence: number
      readonly rejected: number
      readonly at: number
    }
    /**
     * 一个 turn 的成本汇总（按 turn 汇总 tokens，进审计导出）。
     *
     * 不产生模型消息，但**必须**落账——否则"资源可控"没有可出示的证据。
     */
    'usage/summary': UsageSummaryData
    /**
     * 上下文压缩摘要（摘要本身作为会话事件落账，可回放、可审计）。
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
 * 混用会让"撤回旧上下文"顺手把纠正文本也撤掉。
 */
export type UserMessageSource = 'user' | 'context' | 'tool-recovery' | 'runtime-context' | 'handoff-waiting' | 'handoff-handover'

/**
 * 压缩后保留的金融结构化字段（涉及金额/收款人/审批的条目不得只留摘要）。
 *
 * **审批结论 ≠ 执行结果**：`decision` 只回答"批没批"，`execution` 只认 `tool/result`。
 * 二者混写会让压缩后的模型把"只批准了"当成"已转账成功"。
 */
export interface FinancialSummaryEntry {
  /**
   * 金额（元）。
   *
   * 缺省表示**未知**——不是 0 元。渲染时必须写"金额未知"，不得补成 `¥0.00` 伪造金融事实。
   */
  readonly amount?: number
  readonly payee: string
  /**
   * 审批票据 ID。
   *
   * 绿色直通调用**没有票据**（不伪造编号）：此时字段缺省、`decision = 'not-required'`。
   */
  readonly ticketId?: TicketId
  /**
   * 审批结论（不是执行结果）。
   *
   * 绿色直通无票据 = `not-required`；黄/红级在审批前就被拦截 = `not-requested`；
   * 票据已签但没结论 = `pending`。
   */
  readonly decision: FinancialApproval
  /**
   * 调用声明的权限级别（来自 `tool/call.tier`，旧数据可能缺省）。
   *
   * 只用于解释"为什么没有票据"：绿色直通 vs 黄/红级在审批前就被前置拦截。
   */
  readonly tier?: 'green' | 'yellow' | 'red'
  /** 执行结果，只由同一 `callId` 的 `tool/result` 证明（审批拒绝 / 前置拦截 = `blocked`，不是 `failed`）。 */
  readonly execution: FinancialExecution
  /** 失败/拒绝的结构化理由码（来自 `tool/result.code`）。 */
  readonly code?: string
}

/** 审批结论的完整取值（含两种“没有审批结论”的原因）。 */
export type FinancialApproval = ApprovalDecision | 'not-required' | 'not-requested' | 'pending'

/** 金融动作的执行结果（与审批结论分开：批准不等于执行成功）。 */
export type FinancialExecution = 'succeeded' | 'failed' | 'blocked' | 'pending'

/** `compaction/summary` 的载荷。 */
export interface CompactionSummaryData {
  /** 被折叠的首个 turn（含）。 */
  readonly fromTurn: number
  /** 被折叠的最后一个 turn（含）。 */
  readonly toTurn: number
  /** 被折叠的 turn 数。 */
  readonly turns: number
  /**
   * 模型可见的结构化摘要文本（确定性生成，不含模型调用）。
   *
   * 必须**自足**：模型读不到被折叠的原文，摘要不得声称"原文可取回"。
   */
  readonly summary: string
  /** 被折叠事件的 `seq`（仅供审计回跳；模型不可读取，不得在摘要里承诺可取回原文）。 */
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
  /** 缓存命中的输入 tokens（provider 未上报时 0）。 */
  readonly cachedInput: number
  /** 本 turn 的费用（微元，1 元 = 1e6 微元；计价未配置时 0）。 */
  readonly costMicroYuan: number
}

/**
 * turn 结束原因。
 *
 * `guard-stopped` 与 `failed` 的区别：前者是 `agent/turn-stopping` 的主动判停
 * （循环 guard、预算耗尽等），属于治理决策而不是故障；审计与渠道文案必须能区分
 * （阶段 8 R46：判停不再伪装成 `failed`）。
 */
export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'blocked' }
  | { kind: 'aborted' }
  | { kind: 'max-tokens' }
  | { kind: 'guard-stopped'; reason: string }
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

/** 审批结论。 */
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

/** 派生出的模型可见消息。 */
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
