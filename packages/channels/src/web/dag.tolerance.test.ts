/**
 * `DagBuilder` 的容错面（坏事件不许把投影打断）。
 *
 * 事件序列不是只由本项目产生的：域事件走 `appendDomain`，不受事件表约束，
 * 历史会话也可能是旧版本写的。所以这里逐条钉"对不上号时必须怎样"：
 * - 认不出的 `callId` / plan 节点 ⇒ 静默忽略（不凭空长出一个节点）；
 * - 认不出的 `plan/node-result.status` ⇒ 保留原状态（不猜成 ok 也不猜成 failed）；
 * - 空轮次 ⇒ `frame()` 返回 `undefined`，调用方因此不会产出一张空图帧。
 *
 * 生效档位回写 `retier()` 是本轮（`tier/decided`）新增的：声明档位是黄级、
 * 策略判成红级时，DAG 必须画红；但它同样只对"已经登记过的调用"有意义。
 */

import { PLAN_INCIDENT_CODE } from '@bah/runtime'
import { describe, expect, it } from 'vitest'

import { DagBuilder } from './dag.ts'

import type { DagFrame, DagNode } from './frames.ts'

/** 取某一轮的图帧（没有就是 `undefined`）。 */
function frameOf(dag: DagBuilder, turn: number): DagFrame | undefined {
  return dag.frame(turn, 1_700_000_000_000 + turn, turn)
}

/** 按节点 ID 找节点。 */
function nodeOf(frame: DagFrame | undefined, id: string): DagNode | undefined {
  return frame?.nodes.find((node) => node.id === id)
}

describe('DagBuilder · retier（tier/decided 的生效档位回写）', () => {
  it('已登记的调用：节点档位被改写，别的节点不动', () => {
    const dag = new DagBuilder()
    dag.call(1, 1, 'c-red', 'transfer_create', 'yellow')
    dag.call(1, 1, 'c-other', 'account_balance', 'green')

    dag.retier('c-red', 'red')

    const frame = frameOf(dag, 1)
    expect(nodeOf(frame, 'call:c-red')?.tier).toBe('red')
    // 结果状态不受改档影响：还没 settle 就仍是 pending
    expect(nodeOf(frame, 'call:c-red')?.state).toBe('pending')
    expect(nodeOf(frame, 'call:c-other')?.tier).toBe('green')
  })

  it('未登记的 callId ⇒ 静默忽略：不抛、不凭空造节点', () => {
    const dag = new DagBuilder()
    expect(() => dag.retier('ghost', 'red')).not.toThrow()
    expect(frameOf(dag, 1)).toBeUndefined()

    // 别的轮次已登记时，也不能把节点混进未登记的轮次
    dag.call(2, 1, 'c-2', 'account_balance', 'green')
    dag.retier('ghost', 'red')
    expect(frameOf(dag, 1)).toBeUndefined()
    const nodes = frameOf(dag, 2)?.nodes ?? []
    expect(nodes.map((node) => node.id)).not.toContain('call:ghost')
    expect(nodes.filter((node) => node.kind === 'call')).toHaveLength(1)
  })
})

describe('DagBuilder · 认不出的事件与轮次', () => {
  it('未知的 plan/node-result.status ⇒ 保留原状态（不猜成功也不猜失败）', () => {
    const dag = new DagBuilder()
    dag.planNode(1, 'p-1', 'n1', 'account_balance', 1)

    dag.planSettle(1, 'p-1', 'n1', 'exploded')

    expect(nodeOf(frameOf(dag, 1), 'plan:p-1:n1')?.state).toBe('running')

    // 认识的状态才改写；`failed` + 事故码要能还原成 incident
    dag.planSettle(1, 'p-1', 'n1', 'failed', PLAN_INCIDENT_CODE)
    expect(nodeOf(frameOf(dag, 1), 'plan:p-1:n1')?.state).toBe('incident')
  })

  it('未登记的 plan 节点 / 别的 planId ⇒ 静默忽略，不造节点', () => {
    const dag = new DagBuilder()
    dag.planNode(1, 'p-1', 'n1', 'account_balance', 1)

    expect(() => dag.planSettle(1, 'p-1', 'ghost', 'succeeded')).not.toThrow()
    expect(() => dag.planSettle(1, 'p-other', 'n1', 'succeeded')).not.toThrow()
    expect(() => dag.planSettle(1, 'p-other', 'ghost', 'blocked', undefined, ['n0'])).not.toThrow()

    // 节点定位按 `planId#nodeId`（不带轮次）：对不上号就一条都不改，也不新建轮次
    expect(frameOf(dag, 1)?.nodes).toHaveLength(1)
    expect(frameOf(dag, 9)).toBeUndefined()
    expect(nodeOf(frameOf(dag, 1), 'plan:p-1:n1')?.state).toBe('running')
  })

  it('blocked 无依赖 ⇒ 不写 code；有依赖 ⇒ blocked-by:a,b（现场要能看出被谁挡）', () => {
    const dag = new DagBuilder()
    dag.planNode(1, 'p-1', 'a', 'account_balance', 1)
    dag.planNode(1, 'p-1', 'b', 'transfer_create', 2)
    dag.planNode(1, 'p-1', 'c', 'wealth_list', 3)

    dag.planSettle(1, 'p-1', 'b', 'blocked')
    dag.planSettle(1, 'p-1', 'c', 'blocked', undefined, ['a', 'b'])

    expect(nodeOf(frameOf(dag, 1), 'plan:p-1:b')).toMatchObject({ state: 'blocked' })
    expect(nodeOf(frameOf(dag, 1), 'plan:p-1:b')?.code).toBeUndefined()
    expect(nodeOf(frameOf(dag, 1), 'plan:p-1:c')?.code).toBe('blocked-by:a,b')
  })

  it('空轮次与从未出现过的轮次 ⇒ frame() 返回 undefined（调用方不产空帧）', () => {
    const dag = new DagBuilder()
    expect(frameOf(dag, 1)).toBeUndefined()
    // step 登记过节点就不算空：只有真的一条都没有才不产帧
    dag.step(2, 1)
    expect(frameOf(dag, 2)?.nodes).toHaveLength(1)
  })

  it('失败节点的下游改 blocked，已成功的节点不改写（事实优先）', () => {
    const dag = new DagBuilder()
    dag.call(3, 1, 'c-a', 'transfer_preview', 'green')
    dag.call(3, 1, 'c-b', 'transfer_create', 'red')
    dag.settle('c-a', true)
    dag.settle('c-b', false)

    const frame = frameOf(dag, 3)
    expect(nodeOf(frame, 'call:c-a')?.state).toBe('ok')
    expect(nodeOf(frame, 'call:c-b')?.state).toBe('denied')

    // 之后再改档：denied 仍然是 denied
    dag.retier('c-b', 'yellow')
    expect(nodeOf(frameOf(dag, 3), 'call:c-b')?.state).toBe('denied')
  })
})
