/**
 * 计划校验单测（方案 §4.6：validate 12 例，含环 3 例）。
 *
 * 判据不是"报了错"，而是"报对了码 + 环给了能改的路径"。
 */

import { describe, expect, it } from 'vitest'

import { validatePlan, type ValidateOptions } from './validate.ts'

import type { Plan, PlanIssue, PlanNode } from './types.ts'

const OPTIONS: ValidateOptions = { maxNodes: 32, maxEdges: 128, hasTool: () => true }

const node = (
  id: string,
  deps: readonly string[] = [],
  extra: Partial<PlanNode> = {},
): PlanNode => ({ id, tool: 'account_balance', args: {}, deps, ...extra })

const makePlan = (nodes: readonly PlanNode[], planId = 'p-1'): Plan => ({ planId, nodes })

const codesOf = (issues: readonly PlanIssue[]): readonly string[] => issues.map((issue) => issue.code)

describe('validatePlan · 单条规则', () => {
  it('V1 空计划 → plan-empty', () => {
    expect(codesOf(validatePlan(makePlan([]), OPTIONS))).toEqual(['plan-empty'])
  })

  it('V2 超过节点上限 → plan-too-large', () => {
    const nodes = Array.from({ length: 4 }, (_, index) => node(`n${String(index)}`))
    const issues = validatePlan(makePlan(nodes), { ...OPTIONS, maxNodes: 3 })

    expect(codesOf(issues)).toEqual(['plan-too-large'])
  })

  it('V3 id 字符集非法 → plan-node-id（它要进 callId，不能带分隔符）', () => {
    const issues = validatePlan(makePlan([node('a#b')]), OPTIONS)

    expect(codesOf(issues)).toEqual(['plan-node-id'])
    expect(issues[0]?.nodeId).toBe('a#b')
  })

  it('V3 id 重复 → plan-node-duplicate', () => {
    const issues = validatePlan(makePlan([node('a'), node('a')]), OPTIONS)

    expect(codesOf(issues)).toEqual(['plan-node-duplicate'])
  })

  it('V4 依赖不存在 → plan-dep-missing', () => {
    const issues = validatePlan(makePlan([node('a', ['ghost'])]), OPTIONS)

    expect(codesOf(issues)).toEqual(['plan-dep-missing'])
    expect(issues[0]?.dep).toBe('ghost')
  })

  it('V5 自依赖 → plan-self-dep（不算环，环路径必须是真有信息量的东西）', () => {
    const issues = validatePlan(makePlan([node('a', ['a'])]), OPTIONS)

    expect(codesOf(issues)).toEqual(['plan-self-dep'])
  })

  it('V7 工具未注册 → plan-tool-missing', () => {
    const issues = validatePlan(makePlan([node('a', [], { tool: 'launch_rocket' })]), {
      ...OPTIONS,
      hasTool: (name) => name !== 'launch_rocket',
    })

    expect(codesOf(issues)).toEqual(['plan-tool-missing'])
    expect(issues[0]?.tool).toBe('launch_rocket')
  })

  it('V8 args 不可序列化 → plan-args-invalid（NaN 不属于可稳定序列化的 JSON）', () => {
    const issues = validatePlan(makePlan([node('a', [], { args: { amount: Number.NaN } })]), OPTIONS)

    expect(codesOf(issues)).toEqual(['plan-args-invalid'])
  })

  it('V8 args 超过 64KB → plan-args-too-large', () => {
    const issues = validatePlan(makePlan([node('a', [], { args: { remark: 'x'.repeat(70_000) } })]), OPTIONS)

    expect(codesOf(issues)).toEqual(['plan-args-too-large'])
  })

  it('附则：依赖边数上限 → plan-too-many-edges', () => {
    const nodes = [node('a'), node('b'), node('c', ['a', 'b'])]
    const issues = validatePlan(makePlan(nodes), { ...OPTIONS, maxEdges: 1 })

    expect(codesOf(issues)).toEqual(['plan-too-many-edges'])
  })
})

describe('validatePlan · 环（3 例，必须给路径）', () => {
  it('三节点环 a→b→c→a：cyclePath 首尾相同', () => {
    const issues = validatePlan(
      makePlan([node('a', ['c']), node('b', ['a']), node('c', ['b'])]),
      OPTIONS,
    )
    const cycle = issues.find((issue) => issue.code === 'plan-cycle')

    expect(cycle).toBeDefined()
    const path = cycle?.cyclePath ?? []
    expect(path.length).toBe(4)
    expect(path[0]).toBe(path[path.length - 1])
  })

  it('自环（a 依赖 a）走 plan-self-dep，不混进 plan-cycle', () => {
    const issues = validatePlan(makePlan([node('a', ['a'])]), OPTIONS)

    expect(codesOf(issues)).not.toContain('plan-cycle')
  })

  it('长链环（5 节点）也能定位到环上，不把环外节点写进路径', () => {
    const nodes = [
      node('root'),
      node('a', ['root', 'e']),
      node('b', ['a']),
      node('c', ['b']),
      node('d', ['c']),
      node('e', ['d']),
    ]
    const issues = validatePlan(makePlan(nodes), OPTIONS)
    const cycle = issues.find((issue) => issue.code === 'plan-cycle')
    const path = cycle?.cyclePath ?? []

    expect(path.length).toBeGreaterThanOrEqual(4)
    expect(path[0]).toBe(path[path.length - 1])
    expect(path).not.toContain('root')
  })
})

describe('validatePlan · 全量收集', () => {
  it('多处问题一次报全（不短路），且 planId 缺失单独一码', () => {
    const issues = validatePlan(
      { planId: '  ', nodes: [node('a', ['ghost'], { tool: 'nope' }), node('a')] },
      { ...OPTIONS, hasTool: () => false },
    )
    const codes = codesOf(issues)

    expect(codes).toContain('plan-id-invalid')
    expect(codes).toContain('plan-dep-missing')
    expect(codes).toContain('plan-tool-missing')
    expect(codes).toContain('plan-node-duplicate')
  })
})

describe('validatePlan · V9 动态 args 引用（W11）', () => {
  it('TC-W11-02 引用不存在的节点 → plan-args-ref-missing', () => {
    const plan = makePlan([node('a', [], { args: { x: '${node.ghost.id}' } })])
    const issues = validatePlan(plan, OPTIONS)

    expect(codesOf(issues)).toEqual(['plan-args-ref-missing'])
    expect(issues[0]?.nodeId).toBe('a')
    expect(issues[0]?.dep).toBe('ghost')
  })

  it('TC-W11-03 引用旁支（不在 deps 闭包内）→ plan-args-ref-outside-deps', () => {
    const plan = makePlan([
      node('a'),
      node('b'),
      node('c', ['a'], { args: { x: '${node.b.id}' } }),
    ])

    expect(codesOf(validatePlan(plan, OPTIONS))).toEqual(['plan-args-ref-outside-deps'])
  })

  it('间接上游算在闭包里：a → b → c，c 引用 a 合法', () => {
    const plan = makePlan([
      node('a'),
      node('b', ['a']),
      node('c', ['b'], { args: { x: '${node.a.id}' } }),
    ])

    expect(validatePlan(plan, OPTIONS)).toEqual([])
  })

  it('引用自己 → plan-args-ref-outside-deps（解析时自己的 output 还不存在）', () => {
    const plan = makePlan([node('a', [], { args: { x: '${node.a.id}' } })])

    expect(codesOf(validatePlan(plan, OPTIONS))).toEqual(['plan-args-ref-outside-deps'])
  })

  it('非整串 / 无 node. 前缀都不是模板：一个字都不报（TC-W11-05 的静态面）', () => {
    const plan = makePlan([
      node('a'),
      node('b', ['a'], { args: { p: '单号-${node.a.id}', q: '${a + b}', r: '${node.a}' } }),
    ])

    expect(validatePlan(plan, OPTIONS)).toEqual([])
  })

  it('坏路径（空段）退回字面量，不猜下标', () => {
    const plan = makePlan([node('a'), node('b', ['a'], { args: { x: '${node.a..id}' } })])

    expect(validatePlan(plan, OPTIONS)).toEqual([])
  })
})
