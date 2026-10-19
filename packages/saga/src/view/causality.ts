/**
 * 因果拓扑图（SA-13 §3.2）：`happensBefore` 边导出 DAG JSON。
 *
 * - 节点 id 与边端点**统一**用 `row.q`（= `seqInSaga`），不用数组下标：
 *   链记录可能被 `upto` 截断/过滤，下标会漂移。
 * - 因果只认 `hb` 偏序（A6/A8），时间戳仅展示。
 * - Mermaid 直出为可选：与 DAG 同构（同一节点 id、同一组边）。
 */

import type { ChainRow } from '../recon/types.ts'

/** 一条因果边：`from` 先于 `to`（均在同一个 saga 的全序坐标里）。 */
export interface CausalEdge {
  readonly from: number
  readonly to: number
  readonly kind: 'happensBefore' | 'parent'
}

/** 因果图节点。 */
export interface CausalNode {
  readonly id: string
  readonly eventType: string
  readonly sagaId: string
}

/** DAG 导出面。 */
export interface CausalDag {
  readonly nodes: readonly CausalNode[]
  readonly edges: readonly CausalEdge[]
  /** 可选：`graph LR` 直出（节点/边与 JSON 同构）。 */
  readonly mermaid?: string
}

/**
 * 导出因果 DAG。
 *
 * 同 saga 全序 + `happensBefore` 偏序边；跨 saga 的 parent 边需要跨链节点，
 * 由渠道层用 `parent_saga_id` 拼接（本函数只处理单 saga 链，不越界造节点）。
 */
export function causalDag(sagaId: string, rows: readonly ChainRow[]): CausalDag {
  const nodes: CausalNode[] = rows.map((row) => ({
    id: String(row.q),
    eventType: row.t,
    sagaId,
  }))
  const edges: CausalEdge[] = []
  for (const row of rows) {
    for (const hb of row.hb ?? []) {
      edges.push({ from: hb, to: row.q, kind: 'happensBefore' })
    }
  }
  return { nodes, edges, mermaid: toMermaid(nodes, edges) }
}

/**
 * 是否无环。`hb` 只允许指向更早的序号；任何回指/自环都判失败。
 * 导出前由渠道/测试调用（本函数不改图）。
 */
export function isAcyclic(dag: CausalDag): boolean {
  const byId = new Map(dag.nodes.map((node) => [node.id, node]))
  const adjacency = new Map<string, string[]>()
  for (const edge of dag.edges) {
    const from = String(edge.from)
    const to = String(edge.to)
    if (!byId.has(from) || !byId.has(to) || from === to) return false
    const list = adjacency.get(from) ?? []
    list.push(to)
    adjacency.set(from, list)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    const mark = state.get(id)
    if (mark === 'visiting') return false
    if (mark === 'done') return true
    state.set(id, 'visiting')
    for (const next of adjacency.get(id) ?? []) {
      if (!visit(next)) return false
    }
    state.set(id, 'done')
    return true
  }
  return dag.nodes.every((node) => visit(node.id))
}

/** Mermaid `graph LR`：节点 id 直接复用 `row.q`，边集合与 JSON 逐条一致。 */
function toMermaid(nodes: readonly CausalNode[], edges: readonly CausalEdge[]): string {
  const lines = ['graph LR']
  for (const node of nodes) {
    lines.push(`  n${node.id}["${escapeLabel(`${node.id} · ${node.eventType}`)}"]`)
  }
  for (const edge of edges) {
    lines.push(`  n${edge.from} -->|${edge.kind}| n${edge.to}`)
  }
  return lines.join('\n')
}

function escapeLabel(label: string): string {
  return label.replaceAll('"', "'")
}
