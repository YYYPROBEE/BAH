/**
 * goal 账本的确定性实现（04 单 §3.2）。
 *
 * 不读时钟（`now` 注入）、不读随机（`nextId` 注入）、无 I/O；状态转移表参照
 * `plan/machine.ts` 的 `ALLOWED + transition()` 写法，非法转移 fail-loud——
 * 静默吞掉非法转移 = 账本说谎，比崩溃更贵。
 */

import { BahError } from '@bah/util'

import { GOAL_SET_TOOL, type Goal, type GoalStatus, type GoalStore } from './types.ts'

import type { AnySessionEvent } from '../session/types.ts'

/** 合法转移表：三个终态出度为 0；active→active 不合法（重述意图 = 新建 goal）。 */
const ALLOWED: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  active: ['achieved', 'abandoned', 'expired'],
  achieved: [],
  abandoned: [],
  expired: [],
}

const STATUSES: ReadonlySet<string> = new Set<GoalStatus>(['active', 'achieved', 'abandoned', 'expired'])

/**
 * 单会话 active goal 上限。
 *
 * 允许多 goal 并存（同时"准备生日"和"查账单"是正常的）；但无上限时模型可以无限开账，
 * 账本会变成噪声。超出 fail-loud，不做隐式淘汰——隐式放弃也是账本说谎。
 */
export const MAX_ACTIVE_GOALS = 8

export function goalTransition(from: GoalStatus, to: GoalStatus): GoalStatus {
  if (!ALLOWED[from].includes(to)) {
    throw new BahError('goal-illegal-transition', `goal: 非法状态转移 ${from} -> ${to}`, { from, to })
  }
  return to
}

export interface GoalStoreDeps {
  readonly now: () => number
  /** 确定性 id 分配器（如 `g-1`、`g-2`），不用随机 UUID。 */
  readonly nextId: () => string
}

interface GoalStoreInternals {
  readonly store: GoalStore
  /** 重放装载：绕过 create/close 的校验与 id 分配，逐字段还原事件里的原值。 */
  readonly load: (goal: Goal) => void
}

function makeStore(deps: GoalStoreDeps): GoalStoreInternals {
  const goals = new Map<string, Goal>()

  function mustGet(goalId: string): Goal {
    const goal = goals.get(goalId)
    if (goal === undefined) throw new BahError('goal-not-found', `goal: ${goalId} 不存在`, { goalId })
    return goal
  }

  const store: GoalStore = {
    create: (input) => {
      const active = [...goals.values()].filter((goal) => goal.status === 'active')
      if (active.length >= MAX_ACTIVE_GOALS) {
        throw new BahError('goal-limit-exceeded', `goal: active 目标已达上限 ${MAX_ACTIVE_GOALS}`, {})
      }
      const goal: Goal = {
        goalId: deps.nextId(),
        statement: input.statement,
        status: 'active',
        originTurn: input.originTurn,
        ...(input.planId === undefined ? {} : { planId: input.planId }),
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
        createdAt: deps.now(),
      }
      goals.set(goal.goalId, goal)
      return goal
    },
    close: (goalId, status) => {
      const goal = mustGet(goalId)
      const next = goalTransition(goal.status, status)
      const closed: Goal = { ...goal, status: next, closedAt: deps.now() }
      goals.set(goalId, closed)
      return closed
    },
    linkPlan: (goalId, planId) => {
      const goal = mustGet(goalId)
      if (goal.status !== 'active') {
        throw new BahError('goal-illegal-transition', `goal: ${goal.status} 目标不能再关联 plan`, { goalId })
      }
      const linked: Goal = { ...goal, planId }
      goals.set(goalId, linked)
      return linked
    },
    get: (goalId) => goals.get(goalId),
    listActive: () => [...goals.values()].filter((goal) => goal.status === 'active'),
    listAll: () => [...goals.values()],
  }

  return { store, load: (goal) => goals.set(goal.goalId, goal) }
}

export function createGoalStore(deps: GoalStoreDeps): GoalStore {
  return makeStore(deps).store
}

/** 从 `tool/result` 的正文里取出 `goal_set` 的结构化出参（无 projectContent ⇒ 默认 JSON）。 */
function goalFromResult(event: AnySessionEvent): Goal | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data
  if (data.name !== GOAL_SET_TOOL || data.isError) return undefined
  const text = data.content.find((block) => block.type === 'text')
  if (text === undefined || text.type !== 'text') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.text)
  } catch {
    throw new BahError('goal-replay-invalid', 'goal: 重放时 goal_set 的结果不是 JSON', { callId: data.callId })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BahError('goal-replay-invalid', 'goal: 重放时 goal_set 的结果不是对象', { callId: data.callId })
  }
  const record = parsed as Record<string, unknown>
  const goalId = record['goalId']
  const status = record['status']
  if (typeof goalId !== 'string' || typeof status !== 'string' || !STATUSES.has(status)) {
    throw new BahError('goal-replay-invalid', 'goal: 重放时 goal 条目的 goalId/status 非法', { callId: data.callId })
  }
  return record as unknown as Goal
}

/**
 * 从会话事件重放重建 goal 平面（`TC-XSC-28`）。
 *
 * 只认 `tool/result` 中 `name==='goal_set'` 且非 `isError` 的记录；同 `goalId` 后写覆盖先写。
 * `createdAt`/`closedAt` 用事件里的**原值**，不重取时钟——重放必须逐字节还原。
 *
 * @throws `BahError('goal-replay-invalid')` 日志里的 goal_set 结果不可解析（审计断代，不许猜）
 */
export function replayGoalStore(sessionEvents: readonly AnySessionEvent[], deps: GoalStoreDeps): GoalStore {
  const internals = makeStore(deps)
  for (const event of sessionEvents) {
    const goal = goalFromResult(event)
    if (goal !== undefined) internals.load(goal)
  }
  return internals.store
}
