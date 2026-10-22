/**
 * DAG 视图的数据源（施工单 13 §2.1「DAG 规划视图」）。
 *
 * **口径说明（偏差 R-WEB-D1）**：`plan/*` 事件属施工单 14，当前不存在。本版从
 * `tool/call` + `tool/result` 派生**调用图**，验收口径不变：
 * 节点携带权限级别、失败节点下游可见且标记为"已阻断"。
 * `plan/*` 落地后只换本文件的数据来源，视图（`apps/web/src/views/dag.js`）不动。
 *
 * 图结构（每轮一张）：
 *
 * ```text
 * step 1 ──▶ call A ──▶ call B          （同 step 内按 seq 串行）
 *   │
 *   └──▶ step 2 ──▶ call C
 * ```
 *
 * 纯数据、可重复归约：同一事件序列 → 同一张图。
 */

import type { DagEdge, DagFrame, DagNode, FrameTier } from './frames.ts'

/** 单轮的图（节点按插入顺序 = 事件顺序，DP 布局靠它）。 */
interface TurnGraph {
  readonly nodes: DagNode[]
  readonly edges: DagEdge[]
  /** 每个 step 的最后一个节点 ID（同 step 串联用）。 */
  readonly lastByStep: Map<number, string>
  /** 本轮最后一个节点（跨 step 串联用）。 */
  lastId?: string
}

/** 节点 ID。 */
function stepNodeId(turn: number, step: number): string {
  return `step:${String(turn)}:${String(step)}`
}

/** 调用节点 ID。 */
function callNodeId(callId: string): string {
  return `call:${callId}`
}

/** 按轮次累积 DAG。 */
export class DagBuilder {
  private readonly turns = new Map<number, TurnGraph>()
  /** callId → turn（拒绝/失败时定位节点）。 */
  private readonly turnOfCall = new Map<string, number>()

  /** 登记一个 step（重复调用幂等）。 */
  step(turn: number, step: number): void {
    const graph = this.graph(turn)
    const id = stepNodeId(turn, step)
    if (graph.nodes.some((node) => node.id === id)) return
    graph.nodes.push({ id, label: `步骤 ${String(step)}`, kind: 'step', step, tier: 'unknown', state: 'ok' })
    this.link(graph, id, step)
  }

  /** 登记一次工具调用（待执行）。 */
  call(turn: number, step: number, callId: string, name: string, tier: FrameTier): void {
    this.step(turn, step)
    const graph = this.graph(turn)
    const id = callNodeId(callId)
    if (graph.nodes.some((node) => node.id === id)) return
    graph.nodes.push({ id, label: name, kind: 'call', step, tier, state: 'pending' })
    this.turnOfCall.set(callId, turn)
    this.link(graph, id, step)
  }

  /** 结果到达：成功 → `ok`；失败 → 下游待执行节点标记 `blocked`。 */
  settle(callId: string, ok: boolean): void {
    const turn = this.turnOfCall.get(callId)
    if (turn === undefined) return
    const graph = this.graph(turn)
    const index = graph.nodes.findIndex((node) => node.id === callNodeId(callId))
    if (index === -1) return
    const node = graph.nodes[index]
    if (node === undefined) return

    graph.nodes[index] = { ...node, state: ok ? 'ok' : 'denied' }
    if (ok) return

    // 失败节点下游：仍是 pending 的（从未执行）才是"被阻断"；已 ok 的节点事实优先，不改写
    for (let next = index + 1; next < graph.nodes.length; next += 1) {
      const downstream = graph.nodes[next]
      if (downstream !== undefined && downstream.state === 'pending') {
        graph.nodes[next] = { ...downstream, state: 'blocked' }
      }
    }
  }

  /** 生成某一轮的帧（无节点返回 `undefined`，调用方不产空帧）。 */
  frame(turn: number, at: number, seq: number): DagFrame | undefined {
    const graph = this.turns.get(turn)
    if (graph === undefined || graph.nodes.length === 0) return undefined

    const calls = graph.nodes.filter((node) => node.kind === 'call')
    const blocked = graph.nodes.filter((node) => node.state === 'blocked').length
    const denied = graph.nodes.filter((node) => node.state === 'denied').length
    const parts = [`第 ${String(turn)} 轮`, `${String(calls.length)} 个调用`]
    if (denied > 0) parts.push(`${String(denied)} 个被拦截`)
    if (blocked > 0) parts.push(`${String(blocked)} 个下游已阻断`)

    return {
      kind: 'dag',
      seq,
      at,
      turn,
      nodes: graph.nodes.map((node) => node),
      edges: graph.edges.map((edge) => edge),
      summary: parts.join(' · '),
    }
  }

  /** 取/建一轮的图。 */
  private graph(turn: number): TurnGraph {
    const found = this.turns.get(turn)
    if (found !== undefined) return found
    const created: TurnGraph = { nodes: [], edges: [], lastByStep: new Map() }
    this.turns.set(turn, created)
    return created
  }

  /** 把新节点接上前驱：同 step 串行，跨 step 走"上一个 step 的末节点"。 */
  private link(graph: TurnGraph, id: string, step: number): void {
    const sameStep = graph.lastByStep.get(step)
    const from = sameStep ?? graph.lastId
    if (from !== undefined && from !== id) graph.edges.push({ from, to: id })
    graph.lastByStep.set(step, id)
    graph.lastId = id
  }
}
