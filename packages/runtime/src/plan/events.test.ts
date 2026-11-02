/**
 * 事件表单测（方案 §4.6：events 1 例）。
 *
 * 逐键一致必须是**编译期**断言：运行期拿不到接口的键（接口不存在于值空间）。
 * 这条断言在 `tsc -b` 与 vitest 的类型检查下都会生效。
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import { PLAN_SESSION_EVENT_TYPES, type PlanEventType, type PlanSessionEventMap } from './events.ts'

describe('plan 事件表', () => {
  it('事件名联合与载荷表逐键一致（双向），元组无重复且都带 plan/ 前缀', () => {
    expectTypeOf<PlanEventType>().toEqualTypeOf<keyof PlanSessionEventMap>()

    expect(new Set(PLAN_SESSION_EVENT_TYPES).size).toBe(PLAN_SESSION_EVENT_TYPES.length)
    // W10 之前是 6：`plan/resumed` 是第 7 个（续跑不重发 plan/created，它才是新窗口的起点）；
    // W11 把 `plan/node-waiting` 加为第 8 个（审批等待时长，事后值）。
    // ★ `incident` **不占键**：它以 `node-result(status:'failed', code: PLAN_INCIDENT_CODE)` 落账。
    expect(PLAN_SESSION_EVENT_TYPES).toHaveLength(8)
    expect(PLAN_SESSION_EVENT_TYPES.every((type) => type.startsWith('plan/'))).toBe(true)
  })
})
