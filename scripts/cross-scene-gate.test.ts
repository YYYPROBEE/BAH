/**
 * `verify-cross-scene` 的自测（00 §9.2 A3：门禁必须被反夹具打红）。
 *
 * 每个不变量都配一条反夹具；只测"干净仓库是绿的"等于没测门禁——
 * 恒绿的门禁比没有门禁更危险（它给人错觉）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  checkAddNode,
  checkApprovalWindows,
  checkEventKeys,
  checkGoalSource,
  checkNoRerun,
  checkPlanAnchors,
  checkTodoSource,
  gate,
} from './verify-cross-scene.ts'

const FIXTURES = join(import.meta.dirname, '__fixtures__/cross-scene-violations')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

interface Line {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
}

function lines(name: string): Line[] {
  return fixture(name)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Line)
}

describe('verify-cross-scene · 反夹具必须打红', () => {
  it('I1 todo 落账 / derive.ts 读时钟 / 缺 replayPlan', () => {
    expect(checkTodoSource('packages/runtime/src/todo/store.ts', fixture('todo-store-with-append.ts'))).not.toEqual([])
    expect(checkTodoSource('packages/runtime/src/todo/derive.ts', 'const at = Date.now()')).toEqual(
      expect.arrayContaining([
        expect.stringContaining('I1'),
      ]),
    )
    expect(checkTodoSource('packages/runtime/src/todo/derive.ts', 'export const x = 1')).toEqual(
      expect.arrayContaining([expect.stringContaining('replayPlan')]),
    )
    // 正夹具：干净派生器不产 finding
    expect(
      checkTodoSource(
        'packages/runtime/src/todo/derive.ts',
        // 正夹具：有 replayPlan 与合并入口即可（不写字面路径：门禁的路径扫描会把测试里的假 import 当真）
        'function mergeTodoEntries() { return replayPlan }',
      ),
    ).toEqual([])
  })

  it('I2 goal 新事件键 / appendDomain', () => {
    expect(checkGoalSource('packages/runtime/src/goal/tool.ts', fixture('goal-event-key.ts'))).not.toEqual([])
    expect(
      checkGoalSource('packages/runtime/src/goal/store.ts', "s.appendDomain('x', {})"),
    ).not.toEqual([])
    // 注释里讨论 'goal/' 不触发（AST 之外的等价纪律：只认字符串字面量）
    expect(checkGoalSource('packages/runtime/src/goal/types.ts', '// 不出现 goal/ 前缀事件键')).toEqual([])
  })

  it('I3 PlanApi.addNode 与 .addNode( 调用', () => {
    const findings = checkAddNode(
      'packages/runtime/src/plan/types.ts',
      fixture('plan-api-addnode.ts'),
    )
    expect(findings.length).toBeGreaterThanOrEqual(2)
    expect(checkAddNode('packages/runtime/src/plan/types.ts', 'export interface PlanApi { run(): void }')).toEqual([])
  })

  it('I4 批量放行特征串与描述锚点', () => {
    expect(
      checkPlanAnchors('packages/host/src/boot/plugins/plan.ts', fixture('bulk-approve.ts')),
    ).not.toEqual([])
    // 缺锚点句 ⇒ 红
    expect(
      checkPlanAnchors('packages/host/src/boot/plugins/plan.ts', "tier: { level: 'yellow' }"),
    ).toEqual(expect.arrayContaining([expect.stringContaining('锚点句')]))
    // 正夹具：三个锚点齐 ⇒ 绿
    const good = `
      description: '执行本身要一次人工批准，每个写节点还会各自触发审批；'
      tier: { level: 'yellow' },
      const downstream = await next(payload)
      if (payload.call.name !== PLAN_EXECUTE_TOOL) return downstream
    `
    expect(checkPlanAnchors('packages/host/src/boot/plugins/plan.ts', good)).toEqual([])
  })

  it('I4③ 没有独立审批的 transfer_create 节点 ⇒ 红', () => {
    expect(checkApprovalWindows(lines('unapproved-create.jsonl'))).toHaveLength(1)
    const approved = [
      ...lines('unapproved-create.jsonl'),
      { seq: 3, type: 'approval/asked', data: { callId: 'c-a', ticketId: 't-1' } },
    ]
    expect(checkApprovalWindows(approved)).toEqual([])
  })

  it('I5 succeeded 之后重跑 ⇒ 红', () => {
    expect(checkNoRerun(lines('rerun-succeeded.jsonl'))).toHaveLength(1)
  })

  it('I7 事件键形态 0 命中', () => {
    expect(checkEventKeys('packages/runtime/src/goal/x.ts', fixture('goal-event-key.ts'))).not.toEqual([])
    expect(checkEventKeys('packages/runtime/src/goal/x.ts', "const kind = 'goal'")).toEqual([])
  })

  it('干净仓库：gate 绿（findings 空、notes 有扫描面）', async () => {
    const root = join(import.meta.dirname, '..')
    const result = await gate.run(root)
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.notes.length).toBeGreaterThan(0)
  })
})
