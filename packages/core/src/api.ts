/**
 * BAH 内核公开契约 —— `@bah/core` 的冻结面。
 *
 * 冻结时点：M0 · 阶段 1（施工单 01 §8）。签审通过后本文件即为接缝，
 * 任何改动都必须走施工单 00 §9 第 3 条「破坏性变更」流程：同步更新架构文档 + 跑全量快照。
 *
 * 本文件只声明契约，不含任何实现。实现分别落在
 * `context.ts` / `events.ts` / `service.ts` / `plugin.ts` / `scope.ts`（施工单 02）。
 *
 * ## 六项契约与本文件的对应
 *
 * | # | 契约（施工单 01 §8） | 本文件对应 |
 * |---|---|---|
 * | ① | Context 公开成员 | `Context`（施工单 02 §2） |
 * | ② | 五种事件派发模式 | `Events` / `EventMode`（施工单 02 §3） |
 * | ③ | Service provide/inject + waiting 队列 | `ServiceKey` / `ServiceSeam` / `PluginV2.inject`（施工单 02 §5） |
 * | ④ | Plugin 契约 | `PluginV2` / `ConfigSchema`（施工单 02 §7） |
 * | ⑤ | SessionEvent envelope | `SessionEvent` / `SessionEventMap`（施工单 03 §1.1） |
 * | ⑥ | ToolDefinition 契约（含 tier） | `ToolDefinition` / `ToolTier` / `PreExecuteVerdict` / `TicketRef`（施工单 03 §2） |
 *
 * 纪律：本文件只放类型。跨包只认服务键（`ServiceKey`）与事件名，不认实现类。
 */

import type Schema from 'schemastery'
import type { Branded } from '@bah/util'

/* ────────────────────────────────────────────────────────────────────────────
 * 0. 基础词汇
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 撤销句柄：调用即撤销一次贡献，**幂等**（重复调用不报错）。
 *
 * 全仓纪律（施工单 00 §9 第 1 条）：注册即可逆——一切贡献都返回 disposer。
 */
export type Disposer = () => void

/**
 * `ctx.effect()` 登记的清理函数：dispose 时**逆序**执行，并收到 dispose 原因。
 *
 * 例：插件注册了一个定时器或一条服务，dispose 时按后进先出回滚（施工单 02 T-CORE-003/019）。
 */
export type EffectDisposer = (reason?: string) => void

/** 插件名，全仓唯一，形如 `bank:tools`、`core:model`。 */
export type PluginName = string

/** 会话 ID：跨边界不透明，禁止与会话标题等裸字符串互传（施工单 00 §10）。 */
export type SessionId = Branded<'session-id'>

/** 审批票据 ID：跨边界不透明（状态机属主在 bank-core，施工单 07 §3）。 */
export type TicketId = Branded<'ticket-id'>

/* ────────────────────────────────────────────────────────────────────────────
 * Service 接缝：按键寻址 + waiting 队列（施工单 02 §5）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 服务键：跨包唯一入口，内核不认识任何具体服务。
 *
 * `id` 是运行时键（如 `core:model`），必须与插件 `inject` 数组里的字符串一致；
 * `__brand` 是纯类型占位，运行时不存在，只用来让 `T` 参与结构推导。
 */
export interface ServiceKey<T> {
  readonly id: string
  readonly __brand?: T
}

/**
 * provide / inject 的签名与 waiting 队列语义（施工单 01 §8 第 ③ 项）。
 *
 * - `provide` 注册实例并返回注销句柄；同名 key 在注销前重复 provide 属 misconfiguration（抛错）。
 * - `whenReady` 是 waiting 队列的读口：依赖未就绪时**挂起**，依赖 ready 后以实例 resolve；
 *   已就绪则立即 resolve。`inject` 声明的依赖在 `start` 阶段走这条路径注入。
 * - 等待图成环 → 启动即抛，错误里打印环路径（施工单 02 T-CORE-005）。
 */
export interface ServiceSeam {
  /** 注册服务实例；返回的 disposer 注销该注册。 */
  provide<T>(key: ServiceKey<T>, instance: T): Disposer
  /** waiting 队列：未就绪则挂起，就绪后 resolve 实例。 */
  whenReady<T>(key: ServiceKey<T>): Promise<T>
}

/* ────────────────────────────────────────────────────────────────────────────
 * 事件五模式（施工单 02 §3 / §4）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 五种派发模式。**`@mode` 是公开契约**：每个事件在 JSDoc 用 `@mode` 标注，
 * 门禁 `verify-event-modes` 比对「声明 mode」与「实际派发点」（施工单 00 §9）。
 */
export type EventMode = 'emit' | 'serial' | 'parallel' | 'waterfall' | 'bail'

/**
 * 事件总表。
 *
 * M0 只冻结「表存在、事件名是字符串」这一事实；具体事件键与其 `@mode`
 * 在施工单 04 §6 冻结为接缝总表（`docs/` 里的七段管线挂点表同源）。
 * 届时本接口由空索引签名收窄为逐键声明，属**扩展**而非破坏性变更。
 */
export interface BahEventMap {
  readonly [event: string]: unknown
}

/** 事件名：`BahEventMap` 的键（当前为 string）。 */
export type EventName = keyof BahEventMap & string

/**
 * waterfall 的「交还控制权」函数：调用 `next()` 把当前值交还给链上的下一个 handler。
 *
 * 不调 `next()` 的 handler **拥有该判决**——后续 handler 不再执行（这是有意的拦截用法，
 * 见施工单 09 审批）。链长上限 32 级，超出即抛（施工单 02 §4 第 3 条）。
 */
export type WaterfallNext<T> = (value: T) => Promise<T>

/**
 * 事件监听器。
 *
 * 五种模式共用同一形状：`emit` / `serial` / `parallel` 的监听器忽略 `next`；
 * `waterfall` / `bail` 的监听器必须显式 `await next()` 交还（施工单 02 §4 第 1 条）。
 */
export type Listener<K extends EventName = EventName> = (
  payload: BahEventMap[K],
  next: WaterfallNext<BahEventMap[K]>,
) => unknown

/** 事件源：登记监听器 + 五种派发模式。 */
export interface Events {
  /**
   * 登记监听器，返回注销句柄。
   *
   * @param name 事件名，必须是 `BahEventMap` 的键
   */
  on<K extends EventName>(name: K, listener: Listener<K>): Disposer

  /**
   * 低层重载：显式指定 mode 登记（用于尚未进 `BahEventMap` 的动态事件）。
   *
   * @param mode 该监听器的派发模式
   */
  on(name: string, listener: (payload: unknown) => unknown, mode: EventMode): Disposer

  /**
   * 单向通知：不 await、不返回值、不阻塞派发方。
   *
   * @mode emit —— 记账类（`session/event`、`tools/result`）
   */
  emit<K extends EventName>(name: K, payload: BahEventMap[K]): void

  /**
   * 顺序 await 每个监听器，顺序与注册一致。
   *
   * @mode serial —— 有顺序依赖的处理（`agent/turn-stopping`）
   */
  serial<K extends EventName>(name: K, payload: BahEventMap[K]): Promise<void>

  /**
   * `Promise.all` 并发，全部完成才返回。
   *
   * @mode parallel —— 广播类副作用
   */
  parallel<K extends EventName>(name: K, payload: BahEventMap[K]): Promise<void>

  /**
   * 链式传值：每个 handler 显式 `next()` 交还，返回最终（可能被改写的）值。
   *
   * @mode waterfall —— 默认拦截器形态（请求 / 响应 / 判决）
   */
  waterfall<K extends EventName>(name: K, value: BahEventMap[K]): Promise<BahEventMap[K]>

  /**
   * 首个非 `undefined` 返回即短路；无裁决时返回 `undefined`。
   *
   * @mode bail —— 竞争裁决
   */
  bail<K extends EventName>(name: K, value: BahEventMap[K]): Promise<BahEventMap[K] | undefined>
}

/* ────────────────────────────────────────────────────────────────────────────
 * Context 公开成员（施工单 02 §2 / §6）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 单 agent 作用域：键值注册原语，随所属 Context dispose 自动清理。
 *
 * 这是「单 agent 的隔离注册表」，不是多 realm 隔离——多渠道差异一律用 profile 组合解决
 * （裁剪决策见施工单 00 §11）。
 */
export interface AgentScope {
  /** 注册作用域值；返回的 disposer 立即清除该键。 */
  set<T>(key: ServiceKey<T>, value: T): Disposer
  /** 读取作用域值；未设置返回 `undefined`。 */
  get<T>(key: ServiceKey<T>): T | undefined
}

/**
 * 插件运行环境：插件想要的一切都取自 ctx。
 *
 * 生命周期三段（施工单 02 §2）：`install`（插件 apply，可 inject 等待服务）
 * → `start`（就绪钩子）→ `ready`；`dispose(reason)` 逆序回滚全部 effect。
 *
 * 实现约束（施工单 02 §2 要点）：`services` / `waiting` / `disposers` 必须是私有结构，
 * `get` 是服务取用的唯一入口，测试只通过公开 API 验证行为。
 */
export interface Context extends ServiceSeam {
  /** 事件源（五模式）。 */
  readonly events: Events

  /** 单 agent 作用域注册表。 */
  readonly scope: AgentScope

  /**
   * 服务 getter（同步）：按 key 取接口实例。
   *
   * 未注册即抛错（fail-loud）——不返回 `undefined`，杜绝调用方静默降级（施工单 02 T-CORE-017）。
   */
  get<T>(key: ServiceKey<T>): T

  /**
   * 登记一次可逆贡献，同时挂到当前插件名下。
   *
   * dispose 时按登记顺序**逆序**执行，并把 dispose 原因透传给 disposer。
   * 返回的 disposer 用于提前撤销；撤销后不会在 dispose 阶段重复执行。
   */
  effect(disposer: EffectDisposer): Disposer

  /** 推进生命周期到起始态：插件 load 与依赖注入在此阶段完成。 */
  start(): Promise<void>

  /** 逆序回滚全部贡献；`reason` 会透传给每个 disposer（审计与调试用）。 */
  dispose(reason?: string): Promise<void>

  /**
   * 键屏蔽代理：事件与贡献**共享父级**，仅屏蔽指定服务键的 `get`。
   *
   * 收敛版 isolate——只做键屏蔽，不做多 realm 隔离（施工单 00 §11 裁剪决策）。
   */
  isolate(...keys: ServiceKey<unknown>[]): Context
}

/* ────────────────────────────────────────────────────────────────────────────
 * 插件契约（施工单 02 §7）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 配置 schema（schemastery 式）。
 *
 * 校验在 `apply()` **之前**执行，失败即抛（fail-loud，前缀 `bah-core: invalid config for <name>: `）：
 * 未知键、类型错误、阈值越界、正则编译失败都不许静默回退（施工单 00 §9）。
 */
export type ConfigSchema<T> = Schema<T>

/**
 * 插件契约（三段生命周期 + 依赖声明 + 可校验配置）。
 *
 * 插件之间**不能显式相互 import**——只能通过服务键或事件协作，
 * 以保证「贡献可回滚、依赖可等待」（施工单 02 §8 第 2 条）。
 */
export interface PluginV2<Config = unknown> {
  /** 插件名，全仓唯一（如 `bank:tools`）。重名时后者覆盖前者且前者 effect 回滚（T-CORE-020）。 */
  name: string

  /**
   * 依赖的服务名（`ServiceKey.id` 的字符串形式）。
   *
   * `apply` 之前框架等待这些服务 ready；未就绪则该插件挂起在 waiting 队列，
   * 依赖 ready 后注入并继续。等待图成环 → 启动即抛并打印环路径（T-CORE-005）。
   */
  inject?: string[]

  /** 配置 schema；校验失败即载入即抛，绝不静默回退。 */
  config?: ConfigSchema<Config>

  /**
   * 插件入口。
   *
   * 抛错 = 整个应用 fail-loud 退出，错误带 `bah-core: ` 前缀与插件名（T-CORE-002）。
   */
  apply(ctx: Context, config: Config): void | Promise<void>
}

/**
 * 擦除配置类型后的插件视图（存在类型的落点）。
 *
 * TypeScript 无法表达 `PluginV2<exists C>`；`ConfigSchema` 的逆变又让
 * `PluginV2<Specific>` 不能赋给 `PluginV2<unknown>`。内核只存这个擦除形态，
 * 具体类型在 `erasePlugin()` 的 `apply` 包裹里还原一次。
 */
export interface ErasedPluginConfigSchema {
  readonly dict?: Readonly<Record<string, unknown>>
  /** 已擦除类型的校验器（调用方保证传入配置形状）。 */
  readonly validate: (input: unknown) => unknown
}

export interface ErasedPlugin {
  readonly name: string
  readonly inject?: readonly string[]
  readonly config?: ErasedPluginConfigSchema
  apply(ctx: Context, config: unknown): void | Promise<void>
}

/* ────────────────────────────────────────────────────────────────────────────
 * SessionEvent envelope（施工单 03 §1.1）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 会话事件总表（durable 事件族级索引见施工单 03 §1.2）。
 *
 * M0 只冻结 envelope；各事件的 `data` 形态在阶段 3 随 `session/types.ts` 冻结。
 * 届时本接口由索引签名收窄为逐键声明。
 */
export interface SessionEventMap {
  readonly [eventType: string]: unknown
}

/** 会话事件类型：`SessionEventMap` 的键（与事件派发表的键空间**相互独立**）。 */
export type SessionEventType = keyof SessionEventMap & string

/**
 * 会话事件 envelope —— 全仓**唯一**的会话日志行格式。
 *
 * 不变量（施工单 03 §1.1 / §1.3）：
 * - `seq` 单调、连续、不可覆写；`append` 即分配（前值 + 1）
 * - 只追加：不提供 update / delete——append-only 是不变量，不是约定
 * - `ignorable: true` 时旧 reader 可跳过；缺 `ignorable` 即 required-on-read，
 *   旧 reader 遇未知必读事件必须报错而非静默丢（T-SESS-004）
 * - `formatVersion` 高于 reader 支持版本时 `open` 拒绝，不做静默降级（T-SESS-007）
 */
export interface SessionEvent<U extends SessionEventType = SessionEventType> {
  /** 单调、连续的序号（首条为 1）。 */
  seq: number
  /** 落账时间戳（epoch ms）。 */
  at: number
  /** 逻辑格式版本（当前代）。 */
  formatVersion: number
  /** `true` 时旧 reader 可跳过；否则为 required-on-read。 */
  ignorable?: boolean
  /** 事件类型（`SessionEventMap` 的键）。 */
  type: U
  /** 事件载荷，形态由 `type` 决定。 */
  data: SessionEventMap[U]
}

/* ────────────────────────────────────────────────────────────────────────────
 * 工具契约（施工单 03 §2.1 / §2.3 / §2.4）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 权限级别：绿（直接放行）/ 黄（需审批）/ 红（需审批 + 强验证挑战）。
 *
 * 判定解释权归治理平面（施工单 09），工具体不许自带阈值。
 */
export type ToolTierLevel = 'green' | 'yellow' | 'red'

/**
 * 权限级别随工具定义声明。
 *
 * `amountPath` 指向参数里代表金额的字段（如 `args.amount` 的 `'amount'`），
 * 供治理平面按金额分档——阈值只许出现在 Config，不许硬编码在工具体（施工单 01 §6）。
 */
export interface ToolTier {
  level: ToolTierLevel
  amountPath?: string
}

/** JSON Schema 片段（author-facing 参数描述）。 */
export interface ToolJsonSchema {
  type?: string
  description?: string
  /** 其余 JSON Schema 关键字，透传给模型侧 schema 装配。 */
  readonly [keyword: string]: unknown
}

/** 工具参数 schema：必须是 object 根。 */
export interface ToolSchema {
  type: 'object'
  properties?: Readonly<Record<string, ToolJsonSchema>>
  required?: readonly string[]
}

/** 工具结果的内容块（project / finalize 阶段的单位）。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

/**
 * UI 卡片：渠道无关的纯数据。
 *
 * 渠道（Web / IM / 移动）渲染同一份数据，业务逻辑不许塞进渠道（施工单 03 §2.5）。
 */
export interface UiCard {
  /** 卡片种类（渠道按此选模板）。 */
  kind: string
  /** 卡片数据；由 presenter 纯函数从参数/结果映射而来。 */
  data: unknown
}

/**
 * 工具执行上下文（最小冻结面）。
 *
 * 完整字段随七段管线在阶段 3 冻结；M0 只冻结三件任何执行器都必须拿到的东西：
 * 归属会话、本次调用 ID（与 `tool/call` 落账的 callId 一致）、取消信号。
 */
export interface ToolExecContext {
  readonly sessionId: SessionId
  readonly callId: string
  readonly signal: AbortSignal
}

/**
 * 工具定义契约。
 *
 * `tier` 是相对上游的**领域扩展**：权限级别在定义处声明，由治理平面统一解释（施工单 09），
 * 避免策略散落在工具体里（施工单 03 §2.1）。
 */
export interface ToolDefinition<A = unknown, R = unknown> {
  /** 全局唯一、模型可见的工具名。 */
  name: string
  /** 面向模型的用途说明（locale-owned）。 */
  description: string
  /** 参数 JSON Schema。 */
  schema: ToolSchema
  /** 权限级别（定义处声明，治理平面解释）。 */
  tier: ToolTier
  /** 工具体。抛错由管线归一化为 `isError` 结果，不冒泡到主循环（T-TOOL-007）。 */
  execute(args: A, ctx: ToolExecContext): Promise<R>
  /** 执行预置内容（文本 / 图片）。 */
  projectContent?(result: R): ContentBlock[]
  /** 内容不变量：同步、纯函数，不得访问 ctx。 */
  finalizeContent?(content: ContentBlock[]): ContentBlock[]
  /** 待执行卡片（纯函数）。 */
  presentCall?(args: A): UiCard
  /** 完成卡片（纯函数）。 */
  presentResult?(args: A, result: R): UiCard
}

/**
 * `tools/pre-execute` 的判决（施工单 03 §2.3）。
 *
 * 判决顺序不可重排：危险规则 → PII 审计 → 预算 → 断路器冻结 → 三级权限。
 */
export type PreExecuteVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; code: string }
  | {
      kind: 'ask'
      ticket: TicketDraft
      /** 强验证挑战渠道：人脸 / 短信 / U 盾（红级工具）。 */
      challenge?: 'face' | 'sms' | 'ushield'
    }

/**
 * 票据草稿：`ask` 判决请求签发时提交的绑定信息（最小冻结面）。
 *
 * 五绑定细节（会话 / 工具 / 参数指纹 / 金额 / 时效 TTL）由施工单 09 冻结；
 * M0 只冻结「指纹 + 金额 + 时效」这三项在 api 层必须可见。
 */
export interface TicketDraft {
  /** 参数指纹：参数变化即失效。 */
  fingerprint: string
  /** 本次涉及金额（金额分档与预算记账用）。 */
  amount?: number
  /** 票据时效（毫秒）。 */
  ttlMs: number
}

/**
 * 票据引用（施工单 03 §2.4）。
 *
 * 状态机：`issued(pending)` → `approved(allowed-once)` → `redeemed(consumed)` | `blocked`。
 * **核销唯一属主 = bank-core**（施工单 07 §3）；工具面只做生命周期记账，不改状态。
 */
export interface TicketRef {
  ticketId: TicketId
  /** 参数指纹（变化即失效）。 */
  fingerprint: string
  amount?: number
  /** 过期时刻（epoch ms），TTL 由签发时确定。 */
  expiresAt: number
}
