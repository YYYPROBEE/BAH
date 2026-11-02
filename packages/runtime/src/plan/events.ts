/**
 * `plan/*` 的 8 个 durable 事件（方案 §3.5 + W10 的 `plan/resumed` + W11 的 `plan/node-waiting`）。
 *
 * 本文件**只声明，不发事件**：发在 `engine.ts`，落盘在 `host/plugins/plan.ts` 的 `appendDomain`。
 *
 * 四条设计约束（方案 §3.5 原文）：
 * 1. `plan/node-result.status` 是**三值**：`skipped`（调度过没执行）与 `blocked`（没调度）
 *    必须在审计上可区分，否则"计划为什么没跑"永远说不清。
 *    ★ `incident` 不再是第四个值：它以 `status:'failed'` + `code: PLAN_INCIDENT_CODE` 落账，
 *    读侧由 `nodeStateFromResult()` 还原（W11，理由见 `` §70.1）。
 * 2. **不落 args 原文**：只落 `digest` + `tool` + `code`。金额/收款人不得进 append-only 日志；
 * 3. `digest` 用 **canonical JSON**（键排序后 hash）：`JSON.stringify` 的键序取决于构造顺序，
 *    同一份 plan 从 YAML 和字面量构造会得到两个 digest；
 * 4. `appendDomain` 默认 `ignorable: true`：旧 reader 跳过 plan 事件不影响对话重建，
 *    因此**不能用 plan 事件做"会话完整性校验"**的依据。
 */

/**
 * 全量键（顺序 = 一次 run 的落账顺序）。
 *
 * 为什么是 `as const` 元组而不是 `Set`：门禁 `verify-plan-events` 要按 AST 读字面量，
 * 并做**反向覆盖**（每个键至少一个发射点）——数组能同时被类型与门禁消费。
 */
export const PLAN_SESSION_EVENT_TYPES = [
  'plan/created',
  'plan/resumed',
  'plan/node-started',
  'plan/node-waiting',
  'plan/node-result',
  'plan/node-blocked',
  'plan/completed',
  'plan/aborted',
] as const

/** 事件名联合。 */
export type PlanEventType = (typeof PLAN_SESSION_EVENT_TYPES)[number]

/**
 * `plan/*` 载荷表（逐键字面量）。
 *
 * **为什么不像 `session/types.ts` 那样 `declare module '@bah/core'`**：模块增强只能与
 * 模块里**已存在**的声明合并，不能新增一个可被 `import type { X } from '@bah/core'` 取到的
 * 新导出（实测 TS2724）。而 `@bah/core/src/api.ts` 是阶段 1 冻结的契约面，不该为了一个
 * 可选插件的载荷表去改它。声明在本包内不影响任何既有消费方：
 * `verify-plan-events` 按 AST 扫全仓 `*SessionEventMap` 接口，照样能逐键对账。
 */
export interface PlanSessionEventMap {
  'plan/created': {
    readonly planId: string
    readonly nodes: number
    readonly edges: number
    readonly dryRun: boolean
    /** 计划**身份**：canonical JSON 的 sha256 前 16 字节（32 hex），不是展示摘要。 */
    readonly digest: string
    /** 发起方（一律取 `session.sessionId`，方案 §5「额外一条」）。 */
    readonly initiator: string
    readonly at: number
  }
  /**
   * 续跑开始（W10）。**取代** `plan/created` 成为本次窗口的起点：
   * 续跑不重发 `plan/created`——那不是"新建了一张计划"，重发会让审计数出两张计划。
   */
  'plan/resumed': {
    readonly planId: string
    /** 上次运行记录的身份摘要（与本次 `planDigest(plan)` 相等，否则根本走不到这里）。 */
    readonly digest: string
    /** 因上次已 `succeeded` 而跳过的节点数（这些节点**一次都没执行**）。 */
    readonly skipped: number
    /** 本次显式授权重跑的节点（`options.from`，缺省空数组）。 */
    readonly resumedFrom: readonly string[]
    readonly at: number
  }
  'plan/node-started': {
    readonly planId: string
    readonly nodeId: string
    readonly tool: string
    /** plan 内拓扑序位（1..N）。**不是全局序号**；恢复跳过按状态判定。 */
    readonly ordinal: number
    readonly callId: string
    readonly at: number
  }
  /**
   * 节点为等审批花掉的时间（W11）。
   *
   * 为什么 `waitedMs` 是**事后**值：进入等待的那一刻还不知道要等多久。所以这条事件在
   * 审批结论落定之后、`plan/node-result` 之前发——它回答"这个节点卡了多久"，不是"它正在卡"。
   * 值一律由宿主用**注入钟**测（`verify-plan-determinism` 会扫 `Date.now`）。
   *
   * 不落 `ticketId`：票据属于审批面，plan 审计只需要"等了多久"这一个数。
   */
  'plan/node-waiting': {
    readonly planId: string
    readonly nodeId: string
    /** 等待时长（ms，非负）。0 是合法值（注入钟在测试里不走）。 */
    readonly waitedMs: number
    readonly at: number
  }
  'plan/node-result': {
    readonly planId: string
    readonly nodeId: string
    /**
     * 三值，W02 冻结。`incident` 落 `failed` + `code: PLAN_INCIDENT_CODE`
     * （读侧唯一的还原口是 `nodeStateFromResult()`）。
     */
    readonly status: 'succeeded' | 'failed' | 'skipped'
    readonly code?: string
    /** 结果内容摘要（与 `PlanNodeOutcome.summary` 同值）：**原文不进日志**。 */
    readonly digest?: string
    readonly durationMs: number
    readonly at: number
  }
  'plan/node-blocked': {
    readonly planId: string
    readonly nodeId: string
    /** 直接上游里处于 failed / blocked / cancelled 的那些（不是"根因节点"）。 */
    readonly blockedBy: readonly string[]
    readonly reason: 'upstream-failed' | 'upstream-blocked' | 'upstream-cancelled'
    readonly at: number
  }
  'plan/completed': {
    readonly planId: string
    readonly status: 'succeeded' | 'failed' | 'aborted'
    readonly total: number
    readonly succeeded: number
    readonly failed: number
    readonly blocked: number
    readonly skipped: number
    /** 取消时剩下的节点数。五个计数之和必须等于 `total`。 */
    readonly cancelled: number
    readonly durationMs: number
    readonly at: number
  }
  'plan/aborted': {
    readonly planId: string
    /**
     * `halted` 由**宿主**写入（HALT 拦截发生在 `PlanApi.run()` 之前，不进入引擎）：
     * ADR-0002 的枚举扩展，引擎本身不认识 HALT（R-4）。
     */
    readonly reason: 'cancelled' | 'timeout' | 'disposed' | 'halted'
    /** 中止时正在跑的节点（若中止发生在节点之间则缺省）。 */
    readonly atNode?: string
    readonly at: number
  }
}

/**
 * 重放读入的最小事件形状（**结构化**，不依赖任何存储实现）。
 *
 * 只认 `type` + `data`：`seq` / `at` 不参与判定。时钟不可信是刻意的——
 * resume 用的是**本次**注入钟，上次的 `at` 只属于上次那条 run 的时间轴。
 * `data` 是 `unknown`：事件可能来自 JSONL 回放（跨版本），形状要靠运行期判定，
 * 不能靠 `as` 断言把一个没校验过的对象说成 `PlanSessionEventMap[T]`。
 */
export interface PlanEventRecord {
  readonly type: string
  readonly data: unknown
}

/** 单条事件的载荷类型（引擎内部据此收窄 `emit`）。 */
export type PlanEventData<T extends PlanEventType> = PlanSessionEventMap[T]
