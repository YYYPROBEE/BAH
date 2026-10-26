/**
 * 拓扑排序与环路径单测（方案 §4.6：topo 4 例）。
 *
 * 核心断言是**确定性**：同一张图两次调用必须全等，且同层按 id 字典序——
 * 不依赖 `Map` 的插入顺序（换个构造顺序就换个执行顺序，快照必然抖）。
 */

import { describe, expect, it } from 'vitest'

import { findCyclePath, kahnSort } from './topo.ts'

import type { PlanNode } from './types.ts'

const node = (id: string, deps: readonly string[] = []): PlanNode => ({
  id,
  tool: 'account_balance',
  args: {},
  deps,
})

describe('kahnSort', () => {
  it('线性链：依赖在前，顺序唯一', () => {
    const { order, remaining } = kahnSort([node('c', ['b']), node('a'), node('b', ['a'])])

    expect(order).toEqual(['a', 'b', 'c'])
    expect(remaining).toEqual([])
  })

  it('菱形：A → B,C → D（同层按 id 字典序，与构造顺序无关）', () => {
    const forward = kahnSort([node('D', ['C', 'B']), node('C', ['A']), node('B', ['A']), node('A')])
    const backward = kahnSort([node('A'), node('B', ['A']), node('C', ['A']), node('D', ['B', 'C'])])

    expect(forward.order).toEqual(['A', 'B', 'C', 'D'])
    expect(backward.order).toEqual(forward.order)
  })

  it('森林：多个根全部按字典序进入首层', () => {
    const { order } = kahnSort([node('z'), node('m', ['z']), node('a')])

    expect(order).toEqual(['a', 'z', 'm'])
  })

  it('有环时残余非空，且两次调用结果全等（稳定失败）', () => {
    const nodes = [node('a', ['b']), node('b', ['a']), node('free')]
    const first = kahnSort(nodes)
    const second = kahnSort([...nodes].reverse())

    expect(first.order).toEqual(['free'])
    expect(first.remaining).toEqual(['a', 'b'])
    expect(second).toEqual(first)
  })
})

describe('findCyclePath', () => {
  it('只在残余子图里搜：环外节点不进路径', () => {
    const nodes = [node('root'), node('a', ['root', 'c']), node('b', ['a']), node('c', ['b'])]

    expect(findCyclePath(nodes, ['a', 'b', 'c'])).toEqual(['a', 'c', 'b', 'a'])
  })

  it('无环返回空数组', () => {
    expect(findCyclePath([node('a'), node('b', ['a'])])).toEqual([])
  })
})
