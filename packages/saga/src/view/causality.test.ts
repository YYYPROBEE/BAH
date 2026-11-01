/**
 * 因果 DAG 的导出与无环守卫（SA-13）。
 *
 * 既有 observability 用例只钉了「正例无环」这一条；`isAcyclic` 的拒绝分支
 * （未知端点 / 自环 / 二元环）没有判据。守卫一旦退化成恒真，坏图会被静默导出。
 */

import { describe, expect, it } from 'vitest'

import type { ChainRow } from '../recon/types.ts'
import { causalDag, isAcyclic } from './causality.ts'

/** 造一行链记录：`hb` 缺省表示"没有因果前驱"。 */
function row(q: number, t: string, hb?: readonly number[]): ChainRow {
  return hb === undefined ? { q, t, sub: 's' } : { q, t, sub: 's', hb }
}

/** 造一个只用于 `isAcyclic` 判定的节点。 */
function node(id: string): { id: string; eventType: string; sagaId: string } {
  return { id, eventType: 'saga/x', sagaId: 'saga-g' }
}

describe('causalDag', () => {
  it('hb 缺省 ⇒ 没有因果边；节点 id 用 row.q，不随数组下标漂移', () => {
    const dag = causalDag('saga-g', [row(3, 'saga/created'), row(9, 'saga/step-planned')])

    expect(dag.nodes).toEqual([
      { id: '3', eventType: 'saga/created', sagaId: 'saga-g' },
      { id: '9', eventType: 'saga/step-planned', sagaId: 'saga-g' },
    ])
    expect(dag.edges).toEqual([])
  })

  it('mermaid 与 JSON 同构，标签里的双引号被替换（不破坏 graph 语法）', () => {
    const dag = causalDag('saga-g', [row(1, 'saga/"quoted"'), row(2, 'saga/call-result', [1])])

    expect(dag.mermaid).toContain('n1["1 · saga/\'quoted\'"]')
    expect(dag.mermaid).toContain('n1 -->|happensBefore| n2')
  })
})

describe('isAcyclic', () => {
  it('边端点不在节点集合里 ⇒ 拒绝（不放过断边，也不越界造节点）', () => {
    expect(
      isAcyclic({ nodes: [node('1')], edges: [{ from: 1, to: 9, kind: 'happensBefore' }] }),
    ).toBe(false)
  })

  it('自环 ⇒ 拒绝', () => {
    expect(
      isAcyclic({ nodes: [node('1')], edges: [{ from: 1, to: 1, kind: 'happensBefore' }] }),
    ).toBe(false)
  })

  it('二元环 ⇒ 拒绝；无边的孤立节点 ⇒ 通过', () => {
    const cyclic = {
      nodes: [node('1'), node('2')],
      edges: [
        { from: 1, to: 2, kind: 'happensBefore' as const },
        { from: 2, to: 1, kind: 'happensBefore' as const },
      ],
    }
    expect(isAcyclic(cyclic)).toBe(false)
    expect(isAcyclic({ nodes: [node('1'), node('2')], edges: [] })).toBe(true)
  })

  it('共享前驱的菱形 DAG ⇒ 通过（已判定节点复用结果，不重复下降）', () => {
    const diamond = {
      nodes: [node('1'), node('2'), node('3')],
      edges: [
        { from: 1, to: 2, kind: 'happensBefore' as const },
        { from: 1, to: 3, kind: 'happensBefore' as const },
        { from: 2, to: 3, kind: 'happensBefore' as const },
      ],
    }
    expect(isAcyclic(diamond)).toBe(true)
  })
})
