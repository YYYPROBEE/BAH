/**
 * goal 平面（04 单 §3.1）：用户意图的会话级账本，与 plan（一次 DAG 执行）分平面。
 *
 * 落账只经 `goal_set` 工具的 `tool/call` + `tool/result`（D5 零新事件键、D8 goal 落账）。
 * 本文件只声明形状，不实现。
 */

/** 状态封闭联合：收尾一律 `assertNever`，非法转移在 store 里 fail-loud。 */
export type GoalStatus = 'active' | 'achieved' | 'abandoned' | 'expired'

export interface GoalBudget {
  /** 整数分（入库口径）。`goal_set` 入参收**元**，宿主注入的转换器在边界转一次。 */
  readonly amountCents: number
  readonly currency: 'CNY'
}

export interface Goal {
  readonly goalId: string
  /** 脱敏后的意图陈述（原话可能含卡号/全名，账本只留意图）。 */
  readonly statement: string
  readonly status: GoalStatus
  /** 创建时的 turn 序号（来自注入的 `turnOf()`，不读时钟也不猜）。 */
  readonly originTurn: number
  readonly planId?: string
  readonly budget?: GoalBudget
  /** 自由文本约束（"只用活期余额"）。v1 不做机器判定——诚实边界写在这里。 */
  readonly constraints?: readonly string[]
  readonly createdAt: number
  readonly closedAt?: number
}

/**
 * 会话级、跨 turn 存续。
 *
 * 诚实边界：v1 是**进程内** Map；因为 `goal_set` 的 `tool/result` 已落账，
 * 进程重启后可由 `replayGoalStore(sessionEvents)` 重建。所以"落账"是真的，
 * "独立持久化存储"是没有的——不宣称有数据库。
 */
export interface GoalStore {
  readonly create: (input: {
    readonly statement: string
    readonly originTurn: number
    readonly planId?: string
    readonly budget?: GoalBudget
    readonly constraints?: readonly string[]
  }) => Goal
  readonly close: (goalId: string, status: Exclude<GoalStatus, 'active'>) => Goal
  readonly linkPlan: (goalId: string, planId: string) => Goal
  readonly get: (goalId: string) => Goal | undefined
  readonly listActive: () => readonly Goal[]
  readonly listAll: () => readonly Goal[]
}

/** 工具名（常量放 types 以免 store/tool 互相 import 成环）。 */
export const GOAL_SET_TOOL = 'goal_set'

/** `goal_set` 入参：新建（statement）与关闭（goalId + status）二选一。 */
export interface GoalSetArgs {
  readonly statement?: string
  readonly goalId?: string
  readonly status?: Exclude<GoalStatus, 'active'>
  /** 预算金额单位是**元**（与银行工具入参口径一致，facts §2）。 */
  readonly budget?: { readonly amount: number; readonly currency?: 'CNY' }
  readonly planId?: string
  readonly constraints?: readonly string[]
}

/** 成功出参 = 账本条目本体（投影层逐字段直拷，不加工）。 */
export type GoalSetResult = Goal
