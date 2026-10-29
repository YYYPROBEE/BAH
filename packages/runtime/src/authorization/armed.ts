/**
 * 已武装计划账本（`ArmedStore`）+ 回放重建。
 *
 * 落账只走 `plan_arm` / `plan_disarm` 的 `tool/call` + `tool/result`（零新事件键）。
 * 回放**只认结构化出参**，不从模型文本重建——这是"零新键"能成立的根本原因。
 */

import { BahError } from '@bah/util'

import { PLAN_ARM_TOOL, PLAN_DISARM_TOOL, type ArmedPlan } from './types.ts'
import { occurrenceOf } from './recurrence.ts'

import type { AnySessionEvent } from '../session/types.ts'

/** 已武装计划账本（进程内；重启后由 `replayArmedPlans` 重建）。 */
export interface ArmedStore {
  /** 登记一张已武装计划；`windowId` 重复即抛（窗口是身份，不是缓存键）。 */
  readonly arm: (plan: ArmedPlan) => ArmedPlan
  /** 撤销（幂等：已撤销再撤一次返回原条目）。 */
  readonly disarm: (windowId: string) => ArmedPlan
  readonly get: (windowId: string) => ArmedPlan | undefined
  /** 某计划的所有窗口（含已撤销；按武装顺序）。 */
  readonly byPlan: (planId: string) => readonly ArmedPlan[]
  readonly list: () => readonly ArmedPlan[]
  readonly listArmed: () => readonly ArmedPlan[]
}

interface Internals {
  readonly store: ArmedStore
  readonly load: (plan: ArmedPlan) => void
}

function makeStore(): Internals {
  const plans = new Map<string, ArmedPlan>()

  const store: ArmedStore = {
    arm: (plan) => {
      if (plans.has(plan.windowId)) {
        throw new BahError('window-duplicate', `已存在同 id 的授权窗口：${plan.windowId}`, {
          windowId: plan.windowId,
        })
      }
      plans.set(plan.windowId, plan)
      return plan
    },
    disarm: (windowId) => {
      const plan = plans.get(windowId)
      if (plan === undefined) {
        throw new BahError('window-unknown', `授权窗口不存在：${windowId}`, { windowId })
      }
      if (plan.state === 'cancelled') return plan
      const cancelled: ArmedPlan = { ...plan, state: 'cancelled' }
      plans.set(windowId, cancelled)
      return cancelled
    },
    get: (windowId) => plans.get(windowId),
    byPlan: (planId) => [...plans.values()].filter((plan) => plan.planId === planId),
    list: () => [...plans.values()],
    listArmed: () => [...plans.values()].filter((plan) => plan.state === 'armed'),
  }

  return { store, load: (plan) => plans.set(plan.windowId, plan) }
}

export function createArmedStore(): ArmedStore {
  return makeStore().store
}

/** 从 `tool/result` 的正文里取结构化出参（无 projectContent ⇒ 默认 JSON）。 */
function resultRecord(event: AnySessionEvent): Readonly<Record<string, unknown>> | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data
  if (data.isError) return undefined
  if (data.name !== PLAN_ARM_TOOL && data.name !== PLAN_DISARM_TOOL) return undefined
  const text = data.content.find((block) => block.type === 'text')
  if (text === undefined || text.type !== 'text') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.text)
  } catch {
    throw new BahError('window-replay-invalid', `${data.name}: 结果不是 JSON`, {
      callId: data.callId,
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BahError('window-replay-invalid', `${data.name}: 结果不是对象`, { callId: data.callId })
  }
  return parsed as Readonly<Record<string, unknown>>
}

function armedPlanOf(record: Readonly<Record<string, unknown>>, callId: string): ArmedPlan {
  const planId = record['planId']
  const windowId = record['windowId']
  const dueAt = record['dueAt']
  if (typeof planId !== 'string' || typeof windowId !== 'string' || typeof dueAt !== 'number') {
    throw new BahError('window-replay-invalid', 'plan_arm: 出参缺 planId/windowId/dueAt', { callId })
  }
  return record as unknown as ArmedPlan
}

/**
 * 从会话事件重建已武装计划账本。
 *
 * 只认 `plan_arm` / `plan_disarm` 且非 `isError` 的 `tool/result`；
 * `plan_disarm` 把对应窗口置为 `cancelled`（**不删除**：审计要看得见撤回过什么）。
 */
export function replayArmedPlans(sessionEvents: readonly AnySessionEvent[]): ArmedStore {
  const internals = makeStore()
  for (const event of sessionEvents) {
    const record = resultRecord(event)
    if (record === undefined) continue
    if (event.type !== 'tool/result') continue
    if (event.data.name === PLAN_ARM_TOOL) {
      internals.load(armedPlanOf(record, event.data.callId))
      continue
    }
    const windowId = record['windowId']
    if (typeof windowId !== 'string') {
      throw new BahError('window-replay-invalid', 'plan_disarm: 出参缺 windowId', {
        callId: event.data.callId,
      })
    }
    const existing = internals.store.get(windowId)
    if (existing !== undefined) internals.load({ ...existing, state: 'cancelled' })
  }
  return internals.store
}

/**
 * 已执行实例键（`planId#occurrence`），从 `plan/created` 事件派生。
 *
 * 为什么不用新事件：`plan/created` 本来就是"引擎开始跑这张图"的唯一落账点；
 * 用它 + 武装时刻下界 + 周期实例键，足以回答"这个实例跑过没有"，且**零新键**。
 *
 * 口径：
 * - 只算武装之后发生的 run（`at >= armedAt`）——武装前的手动执行不算这个实例；
 * - 周期计划按 run 时刻所属的实例比对（`occurrenceOf(recurrence, at)`），
 *   所以上一个月的执行不会把这个月吞掉。
 */
export function executedInstanceKeys(
  sessionEvents: readonly AnySessionEvent[],
  plans: readonly ArmedPlan[],
): Set<string> {
  const created: { planId: string; at: number }[] = []
  for (const event of sessionEvents) {
    if (String(event.type) !== 'plan/created') continue
    const data = event.data as Readonly<Record<string, unknown>>
    const planId = data['planId']
    const at = data['at']
    if (typeof planId === 'string' && typeof at === 'number') created.push({ planId, at })
  }
  const keys = new Set<string>()
  for (const plan of plans) {
    const instance = occurrenceOf(plan.recurrence, plan.dueAt)
    for (const run of created) {
      if (run.planId !== plan.planId) continue
      if (run.at < plan.armedAt) continue
      if (occurrenceOf(plan.recurrence, run.at) !== instance) continue
      keys.add(`${plan.planId}#${instance}`)
    }
  }
  return keys
}
