import { describe, expect, it } from 'vitest'

import { buildEvidence, sanitizeSpan } from './evidence.ts'
import {
  crossSceneConfidence,
  gateCrossScene,
  inferTargetScene,
  memorySlots,
  planRecall,
  routeNeedsAsk,
  toSnapshot,
} from './recall.ts'
import type { IntentRecallResult } from './recall.ts'

const result = (overrides: Partial<IntentRecallResult> = {}): IntentRecallResult => ({
  memories: [],
  routeCode: 'ROUTE_OK',
  ...overrides,
})

describe('证据脱敏（TC-INT-21）', () => {
  it('手机号与账号整段替换，且不再残留 11/16 位数字', () => {
    const span = sanitizeSpan('给13812345678转500，卡号6222021234561234')
    expect(span).toContain('[redacted:phone]')
    expect(span).toContain('[redacted:account]')
    expect(/\d{11}/.test(span)).toBe(false)
    expect(/\d{16}/.test(span)).toBe(false)
  })

  it('姓名按槽位句式脱敏', () => {
    expect(sanitizeSpan('给张三转500')).toBe('给张**转500')
    expect(sanitizeSpan('转给欧阳娜娜')).toBe('转给欧阳**')
  })

  it('buildEvidence 会先脱敏再落 span', () => {
    const item = buildEvidence('R-VAGUE-1', '给13812345678转500', 'payee', 'memory')
    expect(item).toEqual({
      ruleId: 'R-VAGUE-1',
      span: '给[redacted:phone]转500',
      slot: 'payee',
      slotSource: 'memory',
    })
  })

  it('可选字段缺省时不写键', () => {
    const item = buildEvidence('R-EXP-1', '给张三转500')
    expect('slot' in item).toBe(false)
    expect('slotSource' in item).toBe(false)
    expect(buildEvidence('R-EXP-1', 'x', 'payee')).not.toHaveProperty('slotSource')
  })
})

describe('跨场景闸门（TC-INT-22/23）', () => {
  it('0.59 拒借且给出 low-confidence', () => {
    expect(gateCrossScene({ target: 'transfer', confidence: 0.59 }, 0.6)).toEqual({
      target: 'transfer',
      confidence: 0.59,
      allowed: false,
      rejectReason: 'low-confidence',
    })
  })

  it('0.60 恰好放行（>= 边界）', () => {
    expect(gateCrossScene({ target: 'transfer', confidence: 0.6 }, 0.6)?.allowed).toBe(true)
  })

  it('0.61 放行且无拒绝原因', () => {
    const gate = gateCrossScene({ target: 'transfer', confidence: 0.61 }, 0.6)
    expect(gate?.allowed).toBe(true)
    expect(gate?.rejectReason).toBeNull()
  })

  it('没有 crossSceneRef 时返回 null', () => {
    expect(gateCrossScene(undefined, 0.6)).toBeNull()
  })
})

describe('检索参数与快照', () => {
  it('非跨场景不构造 crossSceneRef', () => {
    expect(planRecall('查余额', 'bills')).toEqual({ scene: 'bills', maxK: 8, utterance: '查余额' })
  })

  it('跨场景按权重评分（把那边的事接着办 = 59）', () => {
    const query = planRecall('把那边的事接着办', 'cross_scene')
    expect(query.crossSceneRef?.confidence).toBe(0.59)
    expect(query.crossSceneRef?.target).toBe('transfer')
  })

  it('权重封顶 100', () => {
    expect(crossSceneConfidence('那边另一个别的接着继续办')).toBe(100)
  })

  it('无跨场景词时评分为 0', () => {
    expect(crossSceneConfidence('查余额')).toBe(0)
  })

  it('目标场景按线索词推断，兜底 transfer', () => {
    expect(inferTargetScene('那边理财的事')).toBe('investment')
    expect(inferTargetScene('那边账单')).toBe('bills')
    expect(inferTargetScene('那边的事')).toBe('transfer')
  })

  it('toSnapshot 把闸门算好，纯函数不再碰阈值', () => {
    const snapshot = toSnapshot(
      result({ crossSceneRef: { target: 'transfer', confidence: 0.59, accepted: false } }),
      0.6,
    )
    expect(snapshot.crossScene).toEqual({
      target: 'transfer',
      confidence: 0.59,
      allowed: false,
      rejectReason: 'low-confidence',
    })
  })

  it('toSnapshot 无 crossSceneRef 时为 null', () => {
    expect(toSnapshot(result(), 0.6).crossScene).toBeNull()
  })

  it('routeCode 三值穷尽（ROUTE_OK 不追问）', () => {
    expect(routeNeedsAsk(toSnapshot(result(), 0.6))).toBe(false)
    expect(routeNeedsAsk(toSnapshot(result({ routeCode: 'EMPTY_UNKNOWN_SCENE' }), 0.6))).toBe(true)
    expect(routeNeedsAsk(toSnapshot(result({ routeCode: 'CROSS_SCENE_REFUSED' }), 0.6))).toBe(true)
  })
})

describe('记忆槽位投影', () => {
  it('逐个字段转成 source=memory 的槽位', () => {
    const snapshot = toSnapshot(
      result({
        memories: [
          {
            unitId: 'm1',
            sceneTag: 'transfer',
            confidence: 0.8,
            renderedText: '上次给王建国转 800 元',
            fields: [
              { name: 'payee', value: '王建国' },
              { name: 'amountCents', value: 80000 },
            ],
          },
        ],
      }),
      0.6,
    )
    expect(memorySlots(snapshot)).toEqual([
      { name: 'payee', value: '王建国', source: 'memory', confidence: 0.8 },
      { name: 'amountCents', value: 80000, source: 'memory', confidence: 0.8 },
    ])
  })

  it('无记忆时为空数组', () => {
    expect(memorySlots(toSnapshot(result(), 0.6))).toEqual([])
  })
})
