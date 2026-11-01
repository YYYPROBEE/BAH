/**
 * 授权平面里原先没有用例走过的两侧（proactive R0–R6 合入后的净余缺口）。
 *
 * 一侧是**失败口径**：这几条分支只在出错时走到，共同点是都不许静默返回。
 * - 周期规则/窗口条件里出现未处理的判别标签 ⇒ 必须抛（AGENTS.md 编码纪律第 6 条）；
 *   静默返回 `undefined` 会让"什么时候该扣钱"变成一个无声的空计划。
 * - 判定时刻是 `NaN`（宿主注入的时钟坏掉）⇒ 必须抛，而不是"找不到下一次"地跳过。
 *
 * 另一侧是**成立口径**：`fact-unchanged` / `amount-within` / `address-unchanged`
 * 三条条件的 `ok:true` 分支从未被执行过，地址版本缺失的那条文案也没人验过。
 * 只测失守侧的用例集，允许"条件永远成立"和"条件永远失守"两种相反的坏实现同时通过。
 *
 * 与既有用例的分工：`recurrence.test.ts` / `window.test.ts` 钉的是正常口径与历法边界，
 * 本文件只补上面两侧——不覆盖对方已钉的内容。
 */

import { describe, expect, it } from 'vitest'

import { nextDueAt, occurrenceOf } from './recurrence.ts'
import { checkCondition, checkWindow } from './window.ts'
import type { ArmedPlan, Recurrence, WindowCondition, WorldSnapshot } from './types.ts'

const NOW = 1_761_200_000_000

function snapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    now: NOW,
    balanceCents: 500_000,
    factVersions: {},
    addressVersions: {},
    cancelledPlans: [],
    ...overrides,
  }
}

function armed(conditions: readonly WindowCondition[]): ArmedPlan {
  return {
    planId: 'p-1',
    windowId: 'w-1',
    planDigest: 'digest-1',
    title: '每月锁钱',
    tier: 'standard',
    conditions,
    budgetCents: 100_000,
    dueAt: NOW,
    recurrence: { every: 'once', dueAt: NOW },
    plan: { planId: 'p-1', nodes: [] },
    armedAt: NOW - 1000,
    state: 'armed',
  }
}

/** 取抛出的错误（没抛就让用例红）。 */
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('期望抛错，但没有抛')
}

describe('周期规则：未处理的判别标签必须抛', () => {
  // 新增 `every` 取值却忘了加 case 时，TS 编译期会拦；但规则来自 YAML / 模型槽位时
  // 它是运行期数据，`as unknown as` 就是真实路径。这里钉的是运行期行为。
  const bogus = { every: 'weekly' } as unknown as Recurrence

  it('occurrenceOf 遇到未知 every ⇒ 抛 recurrence-invalid（不返回 undefined 幂等键）', () => {
    const error = thrown(() => occurrenceOf(bogus, NOW))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('周期规则不可达分支')
  })

  it('nextDueAt 遇到未知 every ⇒ 同样抛（两条入口不许只守一条）', () => {
    expect((thrown(() => nextDueAt(bogus, NOW)) as Error).message).toContain('周期规则不可达分支')
  })

  it('抛出物带结构化 code（不是裸字符串，审计要能分支）', () => {
    const error = thrown(() => nextDueAt(bogus, NOW)) as { code?: unknown }
    expect(error.code).toBe('recurrence-invalid')
  })
})

describe('下一次到期：坏时钟与坏月份必须抛', () => {
  it('monthly 的判定时刻是 NaN ⇒ 24 个月内找不到下一次，fail-loud', () => {
    // 静默跳过就是"该扣的钱这个月没扣"，且没有任何痕迹。
    const error = thrown(() =>
      nextDueAt({ every: 'monthly', day: 5, at: '10:00' }, Number.NaN),
    ) as Error
    expect(error.message).toContain('24 个月')
  })

  it('yearly 的判定时刻是 NaN ⇒ 8 年内找不到下一次，fail-loud', () => {
    const error = thrown(() =>
      nextDueAt({ every: 'yearly', month: 10, day: 22, at: '10:00' }, Number.NaN),
    ) as Error
    expect(error.message).toContain('8 年')
  })

  it('yearly 的月份越界（13 月）⇒ 抛，而不是排到一个幽灵日期', () => {
    // 月历表下标取不到 ⇒ 候选时刻变成 NaN ⇒ 永远不会「晚于 after」，最终走 8 年兜底抛错。
    expect(() => nextDueAt({ every: 'yearly', month: 13, day: 22, at: '10:00' }, NOW)).toThrow(/8 年/)
  })

  it('时刻写成 24:00 ⇒ 越界拒绝（parseClock 的边界，不是靠正则放行）', () => {
    expect(() => nextDueAt({ every: 'daily', at: '24:00' }, NOW)).toThrow(/越界/)
    expect(() => nextDueAt({ every: 'daily', at: '10:60' }, NOW)).toThrow(/越界/)
  })
})

describe('窗口条件：未知条件种类必须抛', () => {
  const unknownCondition = { kind: 'mood-is-good' } as unknown as WindowCondition

  it('checkCondition 对未知 kind 抛（封闭联合不许静默放行）', () => {
    expect(() => checkCondition(unknownCondition, { budgetCents: 1, planId: 'p-1' }, snapshot())).toThrow(
      /未覆盖的条件种类/,
    )
  })

  it('checkWindow 里混进未知条件时同样抛出（复验整体不许吞掉它）', () => {
    expect(() => checkWindow(armed([unknownCondition]), snapshot(), NOW)).toThrow(/未覆盖的条件种类/)
  })
})

describe('窗口条件：成立的一侧（此前只有失守侧有用例）', () => {
  // 只钉失败侧的用例集，会让"永远成立"和"永远失守"两种相反的坏实现同时通过。
  const window = { budgetCents: 100_000, planId: 'p-1' }

  it('fact-unchanged：版本一致 ⇒ ok 且不带 failure', () => {
    const verdict = checkCondition({ kind: 'fact-unchanged', factId: 'f-1', version: 3 }, window, snapshot({ factVersions: { 'f-1': 3 } }))
    expect(verdict.ok).toBe(true)
    expect(verdict.failure).toBeUndefined()
  })

  it('amount-within：预算恰好等于上限 ⇒ ok（口径是"不超过"，不是"小于"）', () => {
    const verdict = checkCondition({ kind: 'amount-within', cents: 100_000 }, window, snapshot())
    expect(verdict.ok).toBe(true)
  })

  it('address-unchanged：版本一致 ⇒ ok 且不带 failure', () => {
    const verdict = checkCondition(
      { kind: 'address-unchanged', addressId: 'a-1', version: 2 },
      window,
      snapshot({ addressVersions: { 'a-1': 2 } }),
    )
    expect(verdict.ok).toBe(true)
    expect(verdict.failure).toBeUndefined()
  })

  it('address-unchanged：地址版本整条缺失 ⇒ 失守且写明「缺失」', () => {
    // 缺失必须与"版本不同"区分开：前者是宿主没取到数，排查方向完全不同。
    const verdict = checkCondition(
      { kind: 'address-unchanged', addressId: 'a-9', version: 2 },
      window,
      snapshot({ addressVersions: {} }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.failure?.actual).toBe('缺失')
  })

  it('三条条件同时成立 ⇒ 整窗复验 ok，且摘要仍然落账（可重算的前提）', () => {
    const verdict = checkWindow(
      armed([
        { kind: 'fact-unchanged', factId: 'f-1', version: 3 },
        { kind: 'amount-within', cents: 100_000 },
        { kind: 'address-unchanged', addressId: 'a-1', version: 2 },
      ]),
      snapshot({ factVersions: { 'f-1': 3 }, addressVersions: { 'a-1': 2 } }),
      NOW,
    )
    expect(verdict.ok).toBe(true)
    expect(verdict.digest.length).toBe(64)
  })
})
