/**
 * 拓扑排序与环路径（方案 §3.3 V6 / §4.2）。
 *
 * 两个纯函数，零 I/O、零时钟：
 * - `kahnSort`：Kahn 算法，**同层按 id 字典序**输出（不依赖 `Map` 迭代顺序——那是插入顺序，
 *   换个构造顺序就换个执行顺序，快照必然不稳定）；
 * - `findCyclePath`：给"有环"配一条**能改得动**的路径（`['a','b','c','a']`）。
 *   只说"有环"等于把排查工作丢回给调用方。
 *
 * 为什么不用现成库：LangGraph 用超步替代、Mastra 用嵌套 flow、DBOS 用命令式——三家都不需要
 * 静态环检测，因为它们的图是**代码写死的**。BAH 的 plan 是**外部传入的数据**，必须自己校验。
 */

import type { PlanNode } from './types.ts'

/** `kahnSort` 的结果：拓扑序 + 无法排序的残余（非空即有环）。 */
export interface TopoResult {
  /** 拓扑序（同层按 id 字典序，确定）。 */
  readonly order: readonly string[]
  /** 排不进去的节点 id（升序）。空数组 = 无环。 */
  readonly remaining: readonly string[]
}

/**
 * Kahn 拓扑排序。
 *
 * 前置条件：`deps` 指向存在的节点（`validatePlan` 的 V4 已保证）。错指向不存在的依赖时
 * 该边被忽略——但那种计划在校验期就已失败，走不到这里。
 *
 * 自依赖（`dep === node.id`）在此被忽略：它的诊断是 `plan-self-dep`，不是 `plan-cycle`，
 * 混在一起会让环路径打印出 `['a','a']` 这种没有信息量的东西。
 */
export function kahnSort(nodes: readonly PlanNode[]): TopoResult {
  const known = new Set(nodes.map((node) => node.id))
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const node of nodes) {
    indegree.set(node.id, 0)
    dependents.set(node.id, [])
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!known.has(dep) || dep === node.id) continue
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1)
      dependents.get(dep)?.push(node.id)
    }
  }

  const ready = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort()
  const order: string[] = []

  while (ready.length > 0) {
    const id = ready.shift() as string
    order.push(id)
    // 逐个减边；同层候选按字典序插入，保证"两次调用全等"
    for (const child of (dependents.get(id) ?? []).slice().sort()) {
      const left = (indegree.get(child) ?? 0) - 1
      indegree.set(child, left)
      if (left === 0) insertSorted(ready, child)
    }
  }

  const placed = new Set(order)
  const remaining = nodes
    .map((node) => node.id)
    .filter((id) => !placed.has(id))
    .sort()

  return { order, remaining }
}

/**
 * 找一条环路径（首尾相同）。
 *
 * @param nodes 全部节点
 * @param remaining `kahnSort` 的残余集合；缺省 = 全图搜索。限定残余子图能让路径只落在环上
 *   （否则会先走到环外节点，打印一条"看起来像环但不是"的路径）
 * @returns 环路径；无环时为空数组
 */
export function findCyclePath(
  nodes: readonly PlanNode[],
  remaining?: readonly string[],
): readonly string[] {
  const scope = new Set(remaining ?? nodes.map((node) => node.id))
  const edges = new Map<string, readonly string[]>()
  for (const node of nodes) {
    if (!scope.has(node.id)) continue
    edges.set(
      node.id,
      node.deps.filter((dep) => scope.has(dep) && dep !== node.id).sort(),
    )
  }

  const done = new Set<string>()
  const stack: string[] = []

  const visit = (id: string): readonly string[] | undefined => {
    if (done.has(id)) return undefined
    const onStack = stack.indexOf(id)
    if (onStack >= 0) return [...stack.slice(onStack), id]
    stack.push(id)
    for (const dep of edges.get(id) ?? []) {
      const found = visit(dep)
      if (found !== undefined) return found
    }
    stack.pop()
    done.add(id)
    return undefined
  }

  for (const id of [...scope].sort()) {
    const found = visit(id)
    if (found !== undefined) return found
  }
  return []
}

/** 按字典序插入（`ready` 始终有序，`shift()` 取到的最小）。 */
function insertSorted(queue: string[], value: string): void {
  let index = queue.length
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i] as string
    if (current > value) {
      index = i
      break
    }
  }
  queue.splice(index, 0, value)
}
