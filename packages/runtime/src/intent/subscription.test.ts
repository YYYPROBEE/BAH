/**
 * 场景 5 意图语料（P7）：20 条真实话术 → 期望 kind / 缺槽 / 是否 ambiguous。
 *
 * 纪律（方案 §P7）：
 * - **不改 `DOMAIN_KEYWORDS`**：加「订阅/续费/扣款」会让「查订阅扣款账单」同时命中
 *   bills + subscription → ambiguous，是回归；
 * - `REQUIRED_SLOTS.subscription = []` 保持不变（问「我有啥订阅」不该被反问必填槽）；
 * - 这 20 条只进单测，不进 eval 冻结面。
 */

import { describe, expect, it } from 'vitest'

import { DOMAIN_KEYWORDS, SCENE_LABELS } from './lexicon.ts'
import { resolveIntent } from './resolve.ts'
import { REQUIRED_SLOTS } from './slots.ts'
import { EMPTY_SLOT_TABLE } from './types.ts'

const TODAY = '2026-10-30'
const CTX = { scene: 'subscription', today: TODAY } as const

function resolve(utterance: string) {
  return resolveIntent(
    { utterance, slots: EMPTY_SLOT_TABLE, recall: null, lastTurnKind: null },
    { ...CTX },
  )
}

/** 20 条语料 → 期望（kind, decision）。 */
const CORPUS: readonly (readonly [string, 'explicit' | 'vague'])[] = [
  ['我有哪些订阅', 'explicit'],
  ['查一下我的订阅', 'explicit'],
  ['每月固定扣多少钱', 'explicit'],
  ['这个月怎么多了 5 块', 'explicit'],
  ['视频会员涨到 35 了？', 'explicit'],
  ['有没有扣了很久忘了的', 'explicit'],
  ['云存储我不用了', 'explicit'],
  ['取消视频会员订阅', 'explicit'],
  ['把云音乐退订了', 'explicit'],
  ['视频会员退订', 'explicit'],
  ['取消所有订阅', 'explicit'],
  ['彻底停掉这家扣款', 'explicit'],
  ['关掉财付通的代扣', 'explicit'],
  ['到期提醒我', 'explicit'],
  ['提前三天提醒我续费', 'explicit'],
  ['帮我盯着云音乐', 'explicit'],
  ['订阅扣款记录看一下', 'explicit'],
  ['上个月那笔会员扣款', 'vague'],
  ['网盘会员是季付吗', 'explicit'],
  ['健身房合约还有多久', 'explicit'],
]

describe('订阅场景 20 条语料', () => {
  it('每条都按固定规则给出 kind，且没有一条被判成 ambiguous', () => {
    const kinds = CORPUS.map(([utterance]) => resolve(utterance).kind)
    expect(kinds).not.toContain('ambiguous')
    for (const [utterance, expected] of CORPUS) {
      const result = resolve(utterance)
      expect(result.kind, utterance).toBe(expected)
    }
  })

  it('订阅无必填槽：explicit 一律 proceed、missing 为空（不反问「要转给谁」）', () => {
    for (const [utterance, expected] of CORPUS) {
      if (expected !== 'explicit') continue
      const result = resolve(utterance)
      expect(result.decision, utterance).toBe('proceed')
      expect(result.missing, utterance).toEqual([])
      expect(result.askHint, utterance).toBeNull()
    }
  })

  it('含历史指代的模糊句 → ask，追问的是订阅类别而不是收款人', () => {
    const result = resolve('上个月那笔会员扣款')
    expect(result.kind).toBe('vague')
    expect(result.decision).toBe('ask')
    expect(result.askHint?.slot).toBe('category')
    expect(result.askHint?.question).toContain('订阅相关')
    expect(result.askHint?.question).not.toContain('转给谁')
  })

  it('「查订阅扣款账单」不会被判成 ambiguous（证明没加订阅域关键词）', () => {
    const result = resolve('查订阅扣款账单')
    expect(result.kind).not.toBe('ambiguous')
    expect(DOMAIN_KEYWORDS['subscription']).toBeUndefined()
  })
})

describe('订阅场景的静态口径', () => {
  it('SCENE_LABELS.subscription = 订阅扣款', () => {
    expect(SCENE_LABELS['subscription']).toBe('订阅扣款')
  })

  it('REQUIRED_SLOTS.subscription 保持空数组', () => {
    expect(REQUIRED_SLOTS['subscription']).toEqual([])
  })
})
