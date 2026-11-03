/**
 * 读取路由：跨域借用的四条判决（设计文档 §7.1）。
 *
 * 既有用例只钉了 `unknown` 不检索；跨域「借」与「拒借」两条路径此前没有判据。
 * 拒借被"优化"成通配检索时，错配会以最高置信度呈现给用户——这里把阈值、
 * 目标域去重与拒借时"一条都不查"的语义钉死。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { createMemoryLayer } from '../layer.ts'
import { CROSS_SCENE_MIN_CONFIDENCE, planRoute } from './router.ts'

import type { MemoryLayer } from '../layer.ts'
import type { MemoryUnitRow } from '../store/index.ts'
import type { RetrieveQuery } from '../types.ts'

const FIXED_NOW = Date.parse('2026-10-22T10:00:00.000Z')
const TENANT = 't-bank'
const USER = 'u-001'

const layers: MemoryLayer[] = []

function makeLayer(sensitivityCeiling?: number): MemoryLayer {
  const layer = createMemoryLayer({
    dbPath: ':memory:',
    now: () => FIXED_NOW,
    ...(sensitivityCeiling === undefined ? {} : { sensitivityCeiling }),
  })
  layers.push(layer)
  return layer
}

afterEach(() => {
  for (const layer of layers.splice(0)) layer.close()
})

function query(overrides: Partial<RetrieveQuery> = {}): RetrieveQuery {
  return {
    tenant: TENANT,
    user_id: USER,
    session_id: 's-2',
    scene: 'transfer',
    ...overrides,
  }
}

function cardStateRow(overrides: Partial<MemoryUnitRow> = {}): MemoryUnitRow {
  return {
    unitId: 'mu_stateful',
    tenant: TENANT,
    userId: USER,
    unitType: 'entity_fact',
    sceneTags: ['card', 'transfer'],
    sensitivity: 2,
    state: 'active',
    subject: 'card:8888',
    predicate: 'card_state',
    object: { status: 'lost' },
    validFrom: '2026-10-01T00:00:00.000Z',
    validTo: null,
    supersededBy: null,
    sourceType: 'user_statement',
    confidence: 0.9,
    provenance: {
      session_id: 's-0',
      turn_id: 1,
      pipeline: { extractor: 'rules@v1', pattern: 'P3' },
    },
    contentHash: 'hash-stateful',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastVerifiedAt: null,
    ...overrides,
  }
}

describe('planRoute：四条判决', () => {
  it('unknown → EMPTY_UNKNOWN_SCENE 且域为空（禁通配全域兜底）', () => {
    expect(planRoute(query({ scene: 'unknown' }))).toEqual({
      routeCode: 'EMPTY_UNKNOWN_SCENE',
      domains: [],
    })
  })

  it('无跨域引用 → 只查源场景', () => {
    expect(planRoute(query())).toEqual({ routeCode: 'ROUTE_OK', domains: ['transfer'] })
  })

  it('置信度恰好等于阈值 0.6 → 允许借用（边界含等号）', () => {
    expect(CROSS_SCENE_MIN_CONFIDENCE).toBe(0.6)
    const plan = planRoute(
      query({ crossSceneRef: { target: 'subscription', confidence: CROSS_SCENE_MIN_CONFIDENCE } }),
    )
    expect(plan.routeCode).toBe('ROUTE_OK')
    expect(plan.domains).toEqual(['transfer', 'subscription'])
    expect(plan.crossSceneRef).toEqual({ target: 'subscription', accepted: true })
  })

  it('目标与源场景相同 → 不重复追加', () => {
    const plan = planRoute(query({ crossSceneRef: { target: 'transfer', confidence: 0.9 } }))
    expect(plan.domains).toEqual(['transfer'])
  })

  it('置信度低于阈值 → CROSS_SCENE_REFUSED，域为空并给出反问建议', () => {
    const plan = planRoute(query({ crossSceneRef: { target: 'subscription', confidence: 0.59 } }))
    expect(plan).toEqual({
      routeCode: 'CROSS_SCENE_REFUSED',
      domains: [],
      crossSceneRef: { target: 'subscription', accepted: false },
      suggestion: `这次的问题涉及「subscription」场景，但我不确定是否该跨场景读取您的偏好。请确认是否允许。`,
    })
  })
})

describe('跨域读取接线（公开 API）', () => {
  it('借用被接受 → 目标域记忆可召回，审计里带 accepted 标记', async () => {
    const layer = makeLayer()
    await layer.ingestTurn({
      tenant: TENANT,
      user_id: USER,
      session_id: 's-1',
      turn_id: 1,
      scene: 'subscription',
      speaker: 'user',
      text: '取消这个订阅',
      recentEntities: ['subscription:netflix'],
    })

    const read = await layer.retrieveMemory(async () => null, query({
      crossSceneRef: { target: 'subscription', confidence: 0.9 },
    }))

    expect(read.routeCode).toBe('ROUTE_OK')
    expect(read.memories).toHaveLength(1)
    expect(read.memories[0]?.shadow).toBe('stale')
    expect(read.logLine.queryPlan.domains).toEqual(['transfer', 'subscription'])
    expect(read.logLine.queryPlan.crossSceneRef).toEqual({
      target: 'subscription',
      accepted: true,
    })
  })

  it('借用被拒 → 一条都不查（retrieved 为空），而不是"查了但不显示"', async () => {
    const layer = makeLayer()
    await layer.ingestTurn({
      tenant: TENANT,
      user_id: USER,
      session_id: 's-1',
      turn_id: 1,
      scene: 'subscription',
      speaker: 'user',
      text: '取消这个订阅',
      recentEntities: ['subscription:netflix'],
    })

    const read = await layer.retrieveMemory(async () => null, query({
      crossSceneRef: { target: 'subscription', confidence: 0.5 },
    }))

    expect(read.routeCode).toBe('CROSS_SCENE_REFUSED')
    expect(read.memories).toHaveLength(0)
    expect(read.logLine.queryPlan.domains).toEqual([])
    expect(read.logLine.retrieved).toEqual([])
    expect(read.logLine.queryPlan.crossSceneRef).toEqual({
      target: 'subscription',
      accepted: false,
    })
  })

  it('读取侧敏感级上限：超限记忆即使场景命中也不装配（fail-closed）', async () => {
    const layer = makeLayer(1)
    layer.store.writeUnit(cardStateRow(), [])

    const read = await layer.retrieveMemory(async () => null, query({ scene: 'card' }))

    expect(read.memories).toHaveLength(0)
    expect(read.logLine.filteredOut).toEqual([{ unitId: 'mu_stateful', reason: 'sensitivity' }])
    // 场景本身是命中的：它是被敏感级挡下，不是"没查到"。
    expect(read.logLine.retrieved).toEqual(['mu_stateful'])
  })
})
