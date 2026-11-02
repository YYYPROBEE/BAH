/**
 * `plan:dag` 的数据结构（方案 §3.2，**终稿**）。
 *
 * 本目录是**纯引擎**：不认识任何宿主包（`@bah/host` / `@bah/bank` / `ToolPipeline`），
 * 唯一宿主依赖是 `PlanInvoker` 这个**函数签名**，不是接口。
 *
 * 为什么是函数不是接口：接口会诱使人写 `import type { ToolPipeline } from '@bah/runtime'`
 * 并把它塞进这里，那就等于让引擎认识宿主。一个 `(node, ctx) => Promise<Outcome>`
 * 把依赖方向钉死，`verify-package-graph` 也不会被破。
 */

import type { TicketAuthorization } from '@bah/core'

/** 节点 id 的字符集与长度（`[A-Za-z0-9_-]{1,64}`）：要能进 `callId`，不能带分隔符。 */
export const PLAN_NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 节点入参序列化后的硬上限（与 `ToolPipeline` 的 `MAX_TOOL_ARGS_BYTES` 同值）。 */
export const MAX_PLAN_ARGS_BYTES = 64 * 1024

/** 计划里的一个节点。 */
export interface PlanNode {
  /** 节点 id：计划内唯一，`[A-Za-z0-9_-]{1,64}`。 */
  readonly id: string
  /** 工具名：必须已注册。 */
  readonly tool: string
  /**
   * 工具入参。
   *
   * 值可以是两种形态：**静态字面量**，或整串形如 `"${node.<id>.<path>}"` 的模板（W11 动态 args）。
   * 模板在**执行前**替换为上游 output 的字段；不支持表达式/算术/函数（`"${a + b}"` 按字面串处理）。
   *
   * ★ `digest` 用**模板原样**字符串计算：替换发生在执行期，不回流到计划身份。
   */
  readonly args: Readonly<Record<string, unknown>>
  /** 依赖的节点 id；空数组 = 根。 */
  readonly deps: readonly string[]
  /** 上游失败时：true → 本节点 `skipped`（下游视为满足）；缺省 → `blocked`。 */
  readonly optional?: boolean
  /**
   * 幂等键（**v1 不消费，只作 digest 素材**）。
   *
   * 预留理由：银行核心支持请求级幂等键之后，节点重试才有意义。
   * 现在不留字段，加的时候会打穿所有快照。
   */
  readonly idempotencyKey?: string
}

/** 外部传入的一张工具调用 DAG（引擎只执行，永不生成）。 */
export interface Plan {
  readonly planId: string
  readonly nodes: readonly PlanNode[]
  /** 仅用于审计展示，不参与调度，**也不进 digest**（改标题不算新意图）。 */
  readonly meta?: { readonly title?: string; readonly initiator?: string }
}

/**
 * 9 态（W11 加 `incident`）。
 *
 * 为什么是数组而不是纯类型联合：态数本身是**口径**（文档、宪法、对外说明都引用它），
 * 用 `length` 把自己的数钉成单测，比让下一个人去数联合类型可靠。
 */
export const PLAN_NODE_STATES = [
  'pending',
  'ready',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'blocked',
  'cancelled',
  /** 外部不可用、需人工介入。终态；`resume` 会把它重置为 `pending`（走 seed，不走转移表）。 */
  'incident',
] as const

/** 9 态，终态不可逆（`incident` 的"可续"是 `resume` 的 seed 语义，不是转移）。 */
export type PlanNodeState = (typeof PLAN_NODE_STATES)[number]

/** 终态集合：进入后不再转移（`machine.ts` 的 `ALLOWED` 表格与它同源）。 */
export const TERMINAL_STATES: ReadonlySet<PlanNodeState> = new Set<PlanNodeState>([
  'succeeded',
  'failed',
  'skipped',
  'blocked',
  'cancelled',
  'incident',
])

/**
 * `incident` 在事件层的**唯一载体**：`plan/node-result(status:'failed', code: 本常量)`。
 *
 * 为什么状态不单独落一个值（两条被否决的路，登记在 `` §70.1）：
 * - 改 W02 冻结的三值 `status` → `status` 与 `code` 变成两个判定者，没有机制保证不矛盾；
 * - 新增 `plan/node-incident` → `countTerminals()` 要认两个事件族，完整性判据二次复杂化。
 *
 * 于是"状态由 code 推导"成了**必须显式化的契约**：常量在这里，推导函数是
 * `nodeStateFromResult()`，两侧都只有这一处。**不许在别处再写 `=== 'upstream-unavailable'`。**
 */
export const PLAN_INCIDENT_CODE = 'upstream-unavailable'

/**
 * 动态 args 运行期解析失败（上游 output 里没有那个字段）。
 *
 * 属于**节点级**失败码（进 `plan/node-result.code`），不是校验码也不是续跑码：
 * 只有执行到那个节点才知道 output 长什么样。
 */
export const PLAN_ARGS_UNRESOLVED_CODE = 'plan-args-unresolved'

/**
 * 事件载荷 → 节点状态（`plan/node-result` 的读侧**唯一**还原口）。
 *
 * ★ 必须先看 `code` 再看 `status`：`incident` 在载荷里是 `failed`，
 * 顺序反过来会让它重放成 `failed` —— 而 `failed` 不在 `resume` 的"重置为 pending"档，
 * TC-W11-07 的后半句（续跑后回 pending 并重跑）会直接红。
 */
export function nodeStateFromResult(
  status: 'succeeded' | 'failed' | 'skipped',
  code: string | undefined,
): PlanNodeState {
  if (status === 'failed' && code === PLAN_INCIDENT_CODE) return 'incident'
  return status
}

/** 一次节点执行的结果（宿主归一化后的形状，不抛错）。 */
export interface PlanNodeOutcome {
  readonly isError: boolean
  /** `BahError.code` 优先，否则 `tool-failed`。 */
  readonly code?: string
  /** 摘要：**不含 args 原文与结果原文**（sha256 hex，`plan/node-result.digest` 直接用它）。 */
  readonly summary: string
  /** 工具返回值：**只在内存传，不进任何事件**（动态 args 从这里取值）。 */
  readonly output?: unknown
  /**
   * 这次失败属于"外部不可用、需要人"（W11）。
   *
   * **由宿主判定，引擎不信 `code`**：引擎据此落 `incident` 并**自己写**
   * `PLAN_INCIDENT_CODE` —— 这样那个码的集合由引擎封闭，工具返回任意字符串都伪造不了它。
   *
   * 语义边界（必须由宿主守住）：只包含**可证明尚未产生副作用**的失败（连接未建立 /
   * 依赖方明确回不可用）。**超时不算**——超时可能发生在扣款之后，把它记成 `incident`
   * 等于给"二次扣款"开一个后门（`incident` 在 resume 里是自动重跑的）。
   */
  readonly incident?: boolean
  /**
   * 本节点为等审批花掉的毫秒数（`plan/node-waiting` 的 `waitedMs`）。
   *
   * 由宿主用**注入钟**测量后回传：引擎不碰时钟，也不该知道审批面存在。
   */
  readonly waitedMs?: number
}

/** 引擎看到的、由宿主注入的节点上下文。 */
export interface PlanInvocationContext {
  readonly planId: string
  readonly nodeId: string
  /** `${planId}#${nodeId}#${attempt}`：P2 重试时 attempt 递增，避免 `tool/call` 撞 callId。 */
  readonly callId: string
  /** plan 内拓扑序位（1..N）。只用于执行顺序与快照排序，**不用于跳过判定**。 */
  readonly ordinal: number
  readonly signal: AbortSignal
}

/** 引擎对宿主的唯一依赖（函数签名）。 */
export type PlanInvoker = (
  node: PlanNode,
  context: PlanInvocationContext,
) => Promise<PlanNodeOutcome>

/** 中止原因（四值：审计理由不许是自由文本；`halted` 见 ADR-0002）。 */
export type PlanAbortReason = 'cancelled' | 'timeout' | 'disposed' | 'halted'

/** 一次 run 的终态。`running` 只出现在运行中的快照里。 */
export type PlanRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted'

/** `run()` 的内部选项。**只由宿主构造**：`initiator` 取自 `session.sessionId`，不进公开 API。 */
export interface PlanRunOptions {
  readonly dryRun?: boolean
  /** 外部取消信号（宿主用它表达"超时"）；超时即 abort，引擎记 `reason: 'timeout'`。 */
  readonly signal?: AbortSignal
  /**
   * 发起方。
   *
   * 方案 §5「额外一条」：`PlanApi.run` **不接受** `initiator` 参数，一律由宿主从会话取，
   * 落进 `plan/created`。这里之所以是必填，就是不让引擎有机会"猜"或留空。
   */
  readonly initiator: string
}

/**
 * `resume()` 的公开选项。
 *
 * 只开放 `from` 一个键：续跑没有 dry-run 语义（dry-run 不留档，也就没有"上次结果"可续），
 * 也不接受 `initiator`（同一张计划沿用首次 `plan/created` 记下的发起方）。
 */
export interface PlanResumeOptions {
  /**
   * 显式授权重跑的 `failed` 节点。
   *
   * **只对 `failed` 生效**：`succeeded` 的节点永远不重跑（重跑 = 二次扣款，
   * 幂等键在 v1 并没有传给银行核心）。缺省 = 一个失败节点都不重试。
   *
   * 每个节点还受 `maxNodeAttempts` 约束：历史 `failed` 条数已达上限时，
   * 点名也会被拒（`plan-resume-retry-exhausted`）——反复重试要换新 `planId`，
   * 而不是在一个 `planId` 上无限续。
   */
  readonly from?: readonly string[]
}

/** `resume()` 的引擎选项：比 `run()` 少 `dryRun`，多 `from`。 */
export interface PlanResumeRunOptions {
  /** 外部取消信号（宿主用它表达"超时"）。 */
  readonly signal?: AbortSignal
  /** 发起方：沿用首次 `plan/created` 记录的发起方由宿主决定，引擎只要求必填。 */
  readonly initiator: string
  /** 见 `PlanResumeOptions.from`。 */
  readonly from?: readonly string[]
}

/**
 * `resume()` 的运行期错误码。
 *
 * **刻意不并进 `PlanIssueCode`**：那是 `validate()` 返回的"计划本身不合法"（全量收集、不短路），
 * 混进来会让前端 / CLI 分不清"这计划有问题"与"拒绝续跑"——前者该改计划，后者该改调用方式
 * 或先修数据。
 */
export const PLAN_RESUME_ERRORS = {
  /** `planDigest(plan)` 与上次运行记录的 `digest` 不一致（计划被改过）。 */
  identityMismatch: 'plan-identity-mismatch',
  /** 会话事件窗口被裁剪 / 上次运行没收尾，重放不完整——**不许猜**。 */
  replayIncomplete: 'plan-replay-incomplete',
  /** `options.from` 指向计划里不存在的 `nodeId`。 */
  targetMissing: 'plan-resume-target-missing',
  /**
   * 该节点的失败次数已达上限（`PlanEngineOptions.maxNodeAttempts`）。
   *
   * 计数口径是 `plan/node-result(status='failed')` 的**累计条数**（跨 resume 窗口），
   * 即"同一节点最多失败 N 次"（含首次运行），**不是**"重试 N 次"。
   *
   * ★ `incident`（`code = PLAN_INCIDENT_CODE`）**不计数**：外部不可用不是"这个节点不行"，
   * 把它算进来会让一次基础设施抖动提前耗尽重试预算。
   */
  retryExhausted: 'plan-resume-retry-exhausted',
  /**
   * 待执行的节点引用了**本次会被跳过**的上游输出（W11 动态 args）。
   *
   * `PlanNodeOutcome.output` 只在内存传、不进事件，所以 `resume` 跳过已 `succeeded` 的上游时
   * 没有 output 可解析。三条路里只有"入口拒绝"是对的（连带重跑 = 二次扣款；
   * output 落事件 = 金额进 append-only 日志）。见 `` §70.1。
   */
  argsUnresolved: 'plan-resume-args-unresolved',
} as const

/** 续跑运行期错误码的联合（便于调用方 `switch`）。 */
export type PlanResumeErrorCode = (typeof PLAN_RESUME_ERRORS)[keyof typeof PLAN_RESUME_ERRORS]

/** 快照里的一个节点。 */
export interface PlanNodeSnapshot {
  readonly nodeId: string
  readonly tool: string
  /** plan 内拓扑序位（1..N）。 */
  readonly ordinal: number
  readonly state: PlanNodeState
  readonly code?: string
  readonly durationMs?: number
}

/** 一次 run 的快照（引擎内存态；不落盘、不做跨进程恢复）。 */
export interface PlanRunSnapshot {
  readonly planId: string
  readonly digest: string
  readonly dryRun: boolean
  readonly status: PlanRunStatus
  readonly nodes: readonly PlanNodeSnapshot[]
  readonly startedAt: number
  readonly finishedAt?: number
  readonly abortReason?: PlanAbortReason
}

/** `PlanApi.run()` 的公开选项。 */
export interface PlanApiRunOptions {
  readonly dryRun?: boolean
  /** 授权来源（ADR-0008）：由 `plan_wake` 注入，逐节点落进 `ticket/*`。 */
  readonly authorization?: TicketAuthorization
}

/** `run()` 的返回值（与 `plan/completed` 的载荷同源）。 */
export interface PlanRunSummary {
  readonly planId: string
  readonly digest: string
  readonly dryRun: boolean
  readonly status: Exclude<PlanRunStatus, 'running'>
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly blocked: number
  readonly skipped: number
  readonly cancelled: number
  readonly durationMs: number
}

/**
 * 对外服务面（`PlanApi`）。
 *
 * 刻意做窄：没有 `addNode`（计划不可变）、没有 `listTools`（那是 registry 的事）。
 * `resume` 是唯一的"再来一次"入口，且**只从会话事件重放**——没有跨进程持久化。
 */
export interface PlanApi {
  /**
   * 执行一张计划。`initiator` 不接受参数——一律由宿主从会话取。
   *
   * `authorization` 只由受控执行器（`plan_wake`）注入：它随每次节点审批落进
   * `ticket/*`（ADR-0008），让"谁批的"在凭证上可。
   */
  run(plan: Plan, options?: PlanApiRunOptions): Promise<PlanRunSummary>
  /**
   * 从上次运行结果接着跑：已 `succeeded` 的节点不重跑，`blocked` 的节点重置后重新调度，
   * `failed` 的节点只在 `options.from` 点名时重试。
   *
   * @throws `BahError('plan-identity-mismatch')` 计划被改过（digest 对不上）
   * @throws `BahError('plan-replay-incomplete')` 会话事件窗口被裁剪 / 上次运行没收尾
   * @throws `BahError('plan-resume-target-missing')` `from` 指向不存在的节点
   * @throws `BahError('plan-resume-retry-exhausted')` 该节点失败次数已达 `maxNodeAttempts`
   * @throws `BahError('plan-resume-args-unresolved')` 待执行节点引用了本次会被跳过的上游输出
   * @throws `BahError('plan-already-running')` 同一 `planId` 正在跑
   */
  resume(plan: Plan, options?: PlanResumeOptions): Promise<PlanRunSummary>
  /** 置取消信号；**已进入的节点跑完**。返回是否命中在跑的 run。 */
  cancel(planId: string, reason?: PlanAbortReason): boolean
  /** 运行中或已完成的快照（dry-run 默认不留，见 `shouldPersist`）。 */
  snapshot(planId: string): PlanRunSnapshot | undefined
}

/** 校验问题码（全量收集，不短路）。 */
export type PlanIssueCode =
  | 'plan-id-invalid'
  | 'plan-empty'
  | 'plan-too-large'
  | 'plan-too-many-edges'
  | 'plan-node-id'
  | 'plan-node-duplicate'
  | 'plan-dep-missing'
  | 'plan-self-dep'
  | 'plan-cycle'
  | 'plan-tool-missing'
  | 'plan-args-invalid'
  | 'plan-args-too-large'
  /** 动态 args 引用了计划里不存在的节点（静态可判定）。 */
  | 'plan-args-ref-missing'
  /**
   * 动态 args 引用了**不在本节点 deps 闭包内**的节点（含引用自己）。
   *
   * 为什么必须是闭包而不是直接 deps：串行执行下，只有"拓扑序在前且一定会先跑"的节点才有 output。
   * 允许旁支引用会让执行顺序变成隐性依赖，拓扑序与快照排序就都失去意义。
   */
  | 'plan-args-ref-outside-deps'

/** 一条校验问题（返回而不抛：调用方决定是拒绝还是告警）。 */
export interface PlanIssue {
  readonly code: PlanIssueCode
  readonly message: string
  readonly nodeId?: string
  readonly dep?: string
  readonly tool?: string
  /** 仅 `plan-cycle`：首尾相同的环路径（`['a','b','c','a']`）。 */
  readonly cyclePath?: readonly string[]
}
