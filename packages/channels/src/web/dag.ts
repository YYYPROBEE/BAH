/**
 * DAG 视图的数据源（施工单 13 §2.1「DAG 规划视图」+ B2「plan 节点图」）。
 *
 * 两个数据源，**分工不同、不混装**：
 *
 * 1. **调用图**（`tool/call` + `tool/result`）：模型这一轮直接调了什么、哪一步被拦截。
 *    这是"执行细节"，B2 之前它是唯一来源（偏差 R-WEB-D1），保留为 fallback。
 * 2. **plan 节点图**（`plan/node-started` / `plan/node-result` / `plan/node-blocked` /
 *    `plan/completed` / `plan/aborted`）：一张受约束计划里每个节点的真实终态。
 *    节点按 `ordinal`（引擎的拓扑执行序）串联成边——这是**执行序**，不是计划里的
 *    deps 边（`plan/created` 只带边数不带节点清单，deps 无法从事件重建；如实登记）。
 *
 * 状态与 `PLAN_NODE_STATES` 对齐：`running` / `succeeded→ok` / `failed` / `blocked` /
 * `skipped` / `cancelled` / `incident`（`status='failed'` + `PLAN_INCIDENT_CODE` 还原）。
 * 纯数据、可重复归约：同一事件序列 → 同一张图。
 */

import { PLAN_INCIDENT_CODE } from '@bah/runtime'

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

/** plan 节点 ID（`plan/` 前缀：与 step/call 节点不相撞）。 */
function planNodeId(planId: string, nodeId: string): string {
  return `plan:${planId}:${nodeId}`
}

/** `plan/node-result.status`（+ incident 还原码）→ 视图状态；未知 status 返回 `undefined`。 */
function planStateOf(status: string, code?: string): DagNode['state'] | undefined {
  if (status === 'succeeded') return 'ok'
  if (status === 'failed') return code === PLAN_INCIDENT_CODE ? 'incident' : 'failed'
  if (status === 'skipped') return 'skipped'
  if (status === 'cancelled') return 'cancelled'
  return undefined
}

/** 按轮次累积 DAG。 */
export class DagBuilder {
  private readonly turns = new Map<number, TurnGraph>()
  /** callId → turn（拒绝/失败时定位节点）。 */
  private readonly turnOfCall = new Map<string, number>()
  /** plan 节点定位：`planId#nodeId` → { turn, nodeId }（settle 时用）。 */
  private readonly planNodeRef = new Map<string, { readonly turn: number; readonly id: string }>()
  /** 每个 (turn, planId) 的最后一个 plan 节点 ID（按 ordinal 串联用）。 */
  private readonly lastPlanNode = new Map<string, string>()

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

  // ── B2：plan 节点图 ──────────────────────────────────────────────────────

  /**
   * 登记一个 plan 节点（`plan/node-started`）。
   *
   * @param ordinal 引擎的拓扑执行序（1 起）：边按它串联，不是计划里的 deps
   */
  planNode(turn: number, planId: string, nodeId: string, tool: string, ordinal: number): void {
    const graph = this.graph(turn)
    const id = planNodeId(planId, nodeId)
    if (graph.nodes.some((node) => node.id === id)) return
    graph.nodes.push({
      id,
      label: `${nodeId} · ${tool}`,
      kind: 'plan',
      step: 0,
      tier: 'unknown',
      state: 'running',
      planId,
    })
    this.planNodeRef.set(`${planId}#${nodeId}`, { turn, id })
    // 按 ordinal 串联：同一张计划里前一个已登记的 plan 节点 → 本节点
    const key = `${String(turn)}#${planId}`
    const previous = this.lastPlanNode.get(key)
    if (previous !== undefined && previous !== id) graph.edges.push({ from: previous, to: id })
    this.lastPlanNode.set(key, id)
    // ordinal 只是展示序；乱序到达（理论不该发生）时按事件序兜底
    void ordinal
  }

  /**
   * plan 节点终态（`plan/node-result` / `plan/node-blocked`）。
   *
   * `failed` + `PLAN_INCIDENT_CODE` 还原为 `incident`（与引擎 `nodeStateFromResult`
   * 的"先 code 后 status"同口径）——视图上 incident 与 failed 必须可区分。
   */
  planSettle(
    turn: number,
    planId: string,
    nodeId: string,
    status: string,
    code?: string,
    blockedBy?: readonly string[],
  ): void {
    if (status === 'blocked') {
      this.planNodeBlocked(turn, planId, nodeId, blockedBy ?? [])
      return
    }
    const ref = this.planNodeRef.get(`${planId}#${nodeId}`)
    if (ref === undefined) return
    const graph = this.graph(ref.turn)
    const index = graph.nodes.findIndex((node) => node.id === ref.id)
    if (index === -1) return
    const node = graph.nodes[index]
    if (node === undefined) return
    const state = planStateOf(status, code)
    if (state === undefined) return
    graph.nodes[index] = { ...node, state, ...(code === undefined ? {} : { code }) }
  }

  /** `plan/node-blocked`：节点没跑（无 result），状态 `blocked`；依赖节点 ID 进 label。 */
  private planNodeBlocked(
    turn: number,
    planId: string,
    nodeId: string,
    blockedBy: readonly string[],
  ): void {
    const ref = this.planNodeRef.get(`${planId}#${nodeId}`)
    if (ref === undefined) return
    const graph = this.graph(ref.turn)
    const index = graph.nodes.findIndex((node) => node.id === ref.id)
    if (index === -1) return
    const node = graph.nodes[index]
    if (node === undefined) return
    graph.nodes[index] = {
      ...node,
      state: 'blocked',
      ...(blockedBy.length > 0 ? { code: `blocked-by:${blockedBy.join(',')}` } : {}),
    }
  }

  /** `plan/aborted`：计划中止，所有还在 `pending`/`running` 的 plan 节点 → `cancelled`。 */
  planAbort(turn: number, planId: string): void {
    const graph = this.graph(turn)
    for (const [index, node] of graph.nodes.entries()) {
      if (node.kind === 'plan' && node.planId === planId && (node.state === 'pending' || node.state === 'running')) {
        graph.nodes[index] = { ...node, state: 'cancelled', code: 'plan-aborted' }
      }
    }
  }

  /** 生成某一轮的帧（无节点返回 `undefined`，调用方不产空帧）。 */
  frame(turn: number, at: number, seq: number): DagFrame | undefined {
    const graph = this.turns.get(turn)
    if (graph === undefined || graph.nodes.length === 0) return undefined

    const calls = graph.nodes.filter((node) => node.kind === 'call')
    const planNodes = graph.nodes.filter((node) => node.kind === 'plan')
    const blocked = graph.nodes.filter((node) => node.state === 'blocked').length
    const denied = graph.nodes.filter((node) => node.state === 'denied').length
    const failed = graph.nodes.filter((node) => node.state === 'failed').length
    const incident = graph.nodes.filter((node) => node.state === 'incident').length
    const parts = [`第 ${String(turn)} 轮`]
    if (planNodes.length > 0) parts.push(`计划节点 ${String(planNodes.length)} 个`)
    if (calls.length > 0) parts.push(`${String(calls.length)} 个调用`)
    if (denied > 0) parts.push(`${String(denied)} 个被拦截`)
    if (failed > 0) parts.push(`${String(failed)} 个失败`)
    if (incident > 0) parts.push(`${String(incident)} 个 incident`)
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
