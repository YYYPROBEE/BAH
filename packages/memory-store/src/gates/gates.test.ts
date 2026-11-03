/**
 * G1–G3 三道写入门的拒收分支与管线接线（设计文档 §5）。
 *
 * 既有用例只覆盖「全部放行」和注入门；结构 / 依据 / 敏感三条拒收码此前
 * 只存在于源码里。这些门是「记忆不是随便记」的唯一定义处——被顺手优化掉时，
 * 端到端用例不会红，因为正常语句本来就走 PASS。这里逐条钉住拒收语义。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { createMemoryLayer } from '../layer.ts'
import { checkBasis } from './basis.ts'
import { checkSensitivity } from './sensitivity.ts'
import { checkStructure } from './structure.ts'

import type { MemoryLayer } from '../layer.ts'
import type { IngestInput, MemoryCandidate } from '../types.ts'

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

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    subject: 'user',
    predicate: 'preferred_card_for',
    object: { card_last4: '8888' },
    scene: 'transfer',
    source: 'user_statement',
    pattern: 'P1',
    rawSpan: '以后转账都用尾号8888的卡',
    confidence: 0.9,
    ...overrides,
  }
}

function input(text: string, overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    tenant: TENANT,
    user_id: USER,
    session_id: 's-1',
    turn_id: 1,
    scene: 'transfer',
    speaker: 'user',
    text,
    ...overrides,
  }
}

describe('G1 结构门', () => {
  it('subject 为空 → EXTRACT_SPO_INCOMPLETE', () => {
    expect(checkStructure(candidate({ subject: '' })).code).toBe('EXTRACT_SPO_INCOMPLETE')
  })

  it('predicate 为空 → EXTRACT_SPO_INCOMPLETE', () => {
    expect(checkStructure(candidate({ predicate: '' })).code).toBe('EXTRACT_SPO_INCOMPLETE')
  })

  it('object 缺失（null）→ EXTRACT_SPO_INCOMPLETE', () => {
    expect(checkStructure(candidate({ object: null })).code).toBe('EXTRACT_SPO_INCOMPLETE')
  })

  it('词表外谓词 → GATE_PREDICATE_UNKNOWN，而不是放行', () => {
    const result = checkStructure(candidate({ predicate: 'favorite_color' }))
    expect(result.code).toBe('GATE_PREDICATE_UNKNOWN')
    expect(result.reason).toContain('favorite_color')
  })

  it('合法 SPO → PASS', () => {
    expect(checkStructure(candidate())).toEqual({ code: 'PASS' })
  })
})

describe('G2 依据门', () => {
  it('词表外谓词没有 retention_basis 依据行 → GATE_NO_BASIS', () => {
    const result = checkBasis('favorite_color', 3)
    expect(result.code).toBe('GATE_NO_BASIS')
    expect(result.reason).toContain('retention_basis')
  })

  it('敏感级高于部署上限 → GATE_NO_BASIS（S2 记忆在 S1 部署里不落库）', () => {
    const result = checkBasis('card_state', 1)
    expect(result.code).toBe('GATE_NO_BASIS')
    expect(result.reason).toContain('S2')
    expect(result.reason).toContain('S1')
  })

  it('敏感级恰好等于上限 → PASS（边界值属于允许范围）', () => {
    expect(checkBasis('card_state', 2)).toEqual({ code: 'PASS' })
  })
})

describe('G3 敏感门', () => {
  it('18 位身份证 → 拒收（GATE_SENSITIVITY），object 不被改写', () => {
    const original = { card_last4: '8888' }
    const verdict = checkSensitivity(candidate({ rawSpan: '身份证 110101199003078888', object: original }))
    expect(verdict.result.code).toBe('GATE_SENSITIVITY')
    expect(verdict.object).toEqual(original)
  })

  it('16 位完整卡号 → PASS，且收敛为尾 4 位（候选 object 被覆盖）', () => {
    const verdict = checkSensitivity(
      candidate({ rawSpan: '卡号 6222021234568888', object: { card_last4: '0000' } }),
    )
    expect(verdict.result.code).toBe('PASS')
    expect(verdict.result.reason).toContain('尾 4 位')
    expect(verdict.object).toEqual({ card_last4: '8888' })
  })

  it('普通文本 → PASS，object 原样返回', () => {
    const original = { card_last4: '8888' }
    const verdict = checkSensitivity(candidate({ rawSpan: '尾号 8888 的卡', object: original }))
    expect(verdict.result).toEqual({ code: 'PASS' })
    expect(verdict.object).toEqual(original)
  })
})

describe('管线接线（公开 API）', () => {
  it('部署上限 S1：卡状态记忆被依据门挡下，一行都不落库', async () => {
    const layer = makeLayer(1)
    const result = await layer.ingestTurn(
      input('我的卡丢了', { scene: 'card', recentEntities: ['card:8888'] }),
    )

    expect(result.written).toBe(0)
    expect(result.rejected.map((item) => item.code)).toEqual(['GATE_NO_BASIS'])
    expect(layer.store.listUnits(TENANT, USER)).toHaveLength(0)
  })

  it('18 位号码（身份证形态）不落库：没有任何路径把它当卡号存下来', async () => {
    const layer = makeLayer()
    const result = await layer.ingestTurn(input('以后转账都用尾号110101199003078888的卡'))

    expect(result.written).toBe(0)
    expect(result.rejected.map((item) => item.code)).toEqual(['GATE_SENSITIVITY'])
    expect(layer.store.listUnits(TENANT, USER)).toHaveLength(0)
  })

  it('16 位完整卡号只落尾 4 位，库里不出现完整卡号', async () => {
    const layer = makeLayer()
    const result = await layer.ingestTurn(input('以后转账都用尾号6222021234568888的卡'))

    expect(result.written).toBe(1)
    const rows = layer.store.listUnits(TENANT, USER)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.object).toEqual({ card_last4: '8888' })
    expect(JSON.stringify(rows[0]?.object)).not.toContain('6222021234568888')
  })

  it('订阅取消按会话实体写入 subscription_state（只记到被指代的那个订阅）', async () => {
    const layer = makeLayer()
    const result = await layer.ingestTurn(
      input('取消这个订阅', { scene: 'subscription', recentEntities: ['subscription:netflix'] }),
    )

    expect(result.written).toBe(1)
    const row = layer.store.listUnits(TENANT, USER)[0]
    expect(row?.subject).toBe('subscription:netflix')
    expect(row?.predicate).toBe('subscription_state')
    expect(row?.object).toEqual({ status: 'cancelled' })
    expect(row?.sceneTags).toEqual(['subscription'])
  })

  it('订阅取消但会话里没有实体 → 反问且不落库（不猜是哪个订阅）', async () => {
    const layer = makeLayer()
    const result = await layer.ingestTurn(input('取消这个订阅', { scene: 'subscription' }))

    expect(result.written).toBe(0)
    const unresolved = result.rejected.find((item) => item.code === 'EXTRACT_SUBJECT_UNRESOLVED')
    expect(unresolved?.reason).toContain('哪个订阅')
    expect(layer.store.listUnits(TENANT, USER)).toHaveLength(0)
  })
})
