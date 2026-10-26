/**
 * 状态机单测（方案 §4.6：machine 2 例，表驱动；W11 扩到 9 态）。
 *
 * 两条判据：**全部合法转移正向通过**、**全部非法转移抛错**。
 * 只测"几个典型转移"等于放行剩下的格子——那些格子里藏着
 * `pending → blocked` 这种"写错了失败传播永远跑不到"的格子。
 *
 * 遍历用的状态集**直接取 `PLAN_NODE_STATES`**，不在这里再抄一份：抄一份就等于
 * "加了第 10 态但忘了改测试"能悄悄过。
 */

import { describe, expect, it } from 'vitest'

import { canTransition, isTerminal, PLAN_STATE_TRANSITIONS, transition } from './machine.ts'
import { PLAN_NODE_STATES, TERMINAL_STATES, type PlanNodeState } from './types.ts'

const STATES: readonly PlanNodeState[] = PLAN_NODE_STATES

describe('transition', () => {
  it('态数是口径：9 个，且 `PLAN_NODE_STATES` 是唯一来源（TC-W11-08 / TC-W11-10）', () => {
    // 加态必须同时改这个元组：文档、宪法、答辩引用的"N 态"都从它来。
    // 断言长度而不是"数一遍联合类型"，是为了让漏改的人在这里红，而不是在 PPT 里错。
    expect(PLAN_NODE_STATES).toHaveLength(9)
    expect(new Set(PLAN_NODE_STATES).size).toBe(9)
    expect(PLAN_NODE_STATES).toContain('incident')
  })

  it('全部合法转移正向通过（9×9 逐格比对表）', () => {
    let legal = 0
    for (const from of STATES) {
      const allowed = PLAN_STATE_TRANSITIONS[from]
      for (const to of STATES) {
        if (allowed.includes(to)) {
          legal += 1
          expect(transition(from, to)).toBe(to)
          expect(canTransition(from, to)).toBe(true)
        }
      }
    }
    // 4(pending) + 2(ready) + 4(running，含新增的 incident) = 10 格
    expect(legal).toBe(10)
    // 表格自身的形状：终态没有出边，且与 TERMINAL_STATES 同源
    for (const state of STATES) {
      if (isTerminal(state)) expect(PLAN_STATE_TRANSITIONS[state]).toEqual([])
      expect(isTerminal(state)).toBe(TERMINAL_STATES.has(state))
    }
  })

  it('全部非法转移抛 plan-illegal-transition', () => {
    let illegal = 0
    for (const from of STATES) {
      for (const to of STATES) {
        if (PLAN_STATE_TRANSITIONS[from].includes(to)) continue
        illegal += 1
        expect(() => transition(from, to)).toThrowError(/非法转移/)
        try {
          transition(from, to)
        } catch (error) {
          expect((error as { code?: string }).code).toBe('plan-illegal-transition')
        }
      }
    }
    // 9×9 = 81 格，合法 10 格（含 pending→blocked / pending→skipped 两条容易漏的）
    expect(illegal).toBe(71)
  })

  it('incident 只可由 running 进入，且没有任何出边（TC-W11-08）', () => {
    for (const from of STATES) {
      if (from === 'running') continue
      expect(canTransition(from, 'incident')).toBe(false)
    }
    expect(canTransition('running', 'incident')).toBe(true)
    // "resume 能把它重置回 pending"不是一条转移：seed 直接覆盖初始状态，不过 transition()
    expect(PLAN_STATE_TRANSITIONS['incident']).toEqual([])
    expect(TERMINAL_STATES.has('incident')).toBe(true)
  })
})
