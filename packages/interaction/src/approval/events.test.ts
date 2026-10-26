/**
 * 领域事件表（施工单 09 硬约束 6）：表与常量一一对应，且都被 `ignorable` 落账。
 *
 * 这条用例同时承担覆盖率职责：`events.ts` 是声明型模块（类型 + 事件名表），
 * 只有常量数组是可执行行；断言它保证「事件名被改名时表不会悄悄漂移」。
 */

import { describe, expect, it } from 'vitest'

import { INTERACTION_SESSION_EVENT_TYPES } from './events.ts'

describe('interaction 领域事件表', () => {
  it('10 个事件按声明顺序登记（ticket/* 6 个 + approval/* 4 个）', () => {
    expect([...INTERACTION_SESSION_EVENT_TYPES]).toEqual([
      'ticket/issued',
      'ticket/approved',
      'ticket/redeemed',
      'ticket/consumed',
      'ticket/blocked',
      'ticket/lease-renewed',
      'approval/duplicate',
      'approval/timeout',
      'approval/challenge-issued',
      'approval/challenge-failed',
    ])
    expect(new Set(INTERACTION_SESSION_EVENT_TYPES).size).toBe(
      INTERACTION_SESSION_EVENT_TYPES.length,
    )
  })
})
