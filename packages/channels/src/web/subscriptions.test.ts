/**
 * 「即将扣款」块：从 `read/subscriptions` 事件派生，挂到 sub_list 卡片上。
 *
 * 这一组守三件事：
 * 1. **口径与槽位一致**：7 天窗口、`reminderAheadDays` 收紧、到期升序——两处算错一个，
 *    模型看到的和用户看到的就会是两份清单；
 * 2. **确定性**：窗口基准是事件自己的 `at`，不是墙上时钟（回放两次必须逐字相同）；
 * 3. **不猜**：字段缺失/形态不对的条目直接丢，缺依据就不写「基于近 N 天」。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { WebProjector } from './project.ts'
import { snapshotOf, upcomingBlockOf } from './subscriptions.ts'

import type { CardView, WebFrame } from './frames.ts'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscriptionId: 's-video',
    merchant: '视频会员',
    amountCents: 3500,
    nextChargeAt: T0 + 2 * DAY,
    status: 'active',
    ...overrides,
  }
}

function payload(confirmed: readonly unknown[], basis?: Record<string, unknown>): Record<string, unknown> {
  return {
    result: { confirmed, detected: [] },
    detectedAt: T0,
    ...(basis === undefined ? {} : { basis }),
    detectorVersion: 'r1',
  }
}

describe('snapshotOf：宽松读取 read/subscriptions 载荷', () => {
  it('正常载荷 → 快照（含取证窗口）', () => {
    const snapshot = snapshotOf(
      payload([item()], { from: T0 - 30 * DAY, to: T0, txnCount: 42 }),
      T0,
    )

    expect(snapshot?.items).toHaveLength(1)
    expect(snapshot?.items[0]?.merchant).toBe('视频会员')
    expect(snapshot?.txnCount).toBe(42)
    expect(snapshot?.at).toBe(T0)
  })

  it('形态不对不抛错：返回 undefined 或跳过坏条目', () => {
    expect(snapshotOf('nope', T0)).toBeUndefined()
    expect(snapshotOf({}, T0)).toBeUndefined()
    expect(snapshotOf({ result: {} }, T0)).toBeUndefined()

    const mixed = snapshotOf(payload([item({ amountCents: undefined }), item({ subscriptionId: 's-news' })]), T0)
    expect(mixed?.items.map((entry) => entry.subscriptionId)).toEqual(['s-news'])
  })

  it('非对象条目与空字符串字段一律跳过（不补默认值）', () => {
    const snapshot = snapshotOf(
      payload([null, 's-news', 42, item({ merchant: '', status: '' }), item()]),
      T0,
    )

    expect(snapshot?.items.map((entry) => entry.subscriptionId)).toEqual(['s-video'])
  })

  it('缺 detectedAt 时以事件时刻为生成时间（回放确定性）', () => {
    const snapshot = snapshotOf({ result: { confirmed: [], detected: [] } }, T0)
    const block = upcomingBlockOf(snapshot!)

    expect(block.basisNote).toBe('基于近 0 天 0 笔流水 · 生成于 2023-11-14')
  })
})

describe('upcomingBlockOf：窗口、提前量、排序、上限', () => {
  it('只取 active 且落在 7 天窗口内的（paused 与过期都排除）', () => {
    const snapshot = snapshotOf(
      payload([
        item({ subscriptionId: 's-a', nextChargeAt: T0 + 1 * DAY }),
        item({ subscriptionId: 's-b', status: 'paused', nextChargeAt: T0 + 1 * DAY }),
        item({ subscriptionId: 's-c', nextChargeAt: T0 - 1 * DAY }),
        item({ subscriptionId: 's-d', nextChargeAt: T0 + 9 * DAY }),
      ]),
      T0,
    )
    const block = upcomingBlockOf(snapshot!)

    expect(block.rows.map((row) => row[0])).toEqual(['视频会员'])
    expect(block.summary).toBe('1 项 · 7 天内共 ¥35.00')
  })

  it('reminderAheadDays 收紧窗口（提前 1 天 → 3 天后的那条不列）', () => {
    const snapshot = snapshotOf(
      payload([
        item({ subscriptionId: 's-a', merchant: '明天扣', nextChargeAt: T0 + 1 * DAY, reminderAheadDays: 1 }),
        item({ subscriptionId: 's-b', merchant: '三天后扣', nextChargeAt: T0 + 3 * DAY, reminderAheadDays: 1 }),
      ]),
      T0,
    )
    const block = upcomingBlockOf(snapshot!)

    expect(block.rows.map((row) => row[0])).toEqual(['明天扣'])
  })

  it('到期升序，同刻按 subscriptionId 升序；超过 5 条只列前 5 并注明', () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      item({ subscriptionId: `s-${String(index)}`, nextChargeAt: T0 + (index + 1) * 1000 }),
    )
    const block = upcomingBlockOf(snapshotOf(payload(items), T0)!)

    expect(block.rows).toHaveLength(5)
    expect(block.summary).toContain('（下列前 5 项）')
  })

  it('窗口内一条都没有也出块，但不出表', () => {
    const block = upcomingBlockOf(snapshotOf(payload([]), T0)!)

    expect(block.rows).toHaveLength(0)
    expect(block.summary).toBe('7 天内没有即将扣款')
  })

  it('到期时刻就是查询时刻 → 标「今天」，不写成「0 天后」', () => {
    const block = upcomingBlockOf(snapshotOf(payload([item({ nextChargeAt: T0 })]), T0)!)

    expect(block.rows[0]).toEqual(['视频会员', '¥35.00', '11-14（今天）'])
  })

  it('依据行写清"基于近 N 天 M 笔流水 · 生成于哪一天"', () => {
    const block = upcomingBlockOf(
      snapshotOf(payload([item()], { from: T0 - 30 * DAY, to: T0, txnCount: 42 }), T0)!,
    )

    expect(block.basisNote).toBe('基于近 30 天 42 笔流水 · 生成于 2023-11-14')
  })
})

describe('投影器：sub_list 卡片带「即将扣款」块', () => {
  function project(events: readonly Record<string, unknown>[]): ReturnType<WebProjector['frames']> {
    const projector = new WebProjector()
    for (const event of events) projector.apply(event as unknown as AnySessionEvent)
    return projector.frames()
  }

  /** 取工具帧的卡片（缺任何一个都算用例失败，不做静默跳过）。 */
  function cardOf(frame: WebFrame | undefined): CardView {
    if (frame?.kind !== 'tool') throw new Error(`期望工具帧，实际 ${String(frame?.kind)}`)
    if (frame.card === undefined) throw new Error('工具帧缺 card')
    return frame.card
  }

  function callAndResult(): readonly Record<string, unknown>[] {
    return [
      { seq: 1, at: T0, formatVersion: 1, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 2,
        at: T0,
        formatVersion: 1,
        type: 'read/subscriptions',
        data: payload([item()], { from: T0 - 30 * DAY, to: T0, txnCount: 42 }),
      },
      {
        seq: 3,
        at: T0,
        formatVersion: 1,
        type: 'tool/call',
        data: { callId: 'call-sub', name: 'sub_list', args: {}, fingerprint: 'x', tier: { level: 'green' }, at: T0 },
      },
      {
        seq: 4,
        at: T0,
        formatVersion: 1,
        type: 'tool/result',
        data: { callId: 'call-sub', name: 'sub_list', isError: false, content: [{ type: 'text', text: '订阅 1 项' }], durationMs: 0 },
      },
    ]
  }

  it('成功结果 → 台账模板 + 即将扣款字段/表/依据', () => {
    const card = cardOf(project(callAndResult()).find((entry) => entry.kind === 'tool'))

    expect(card.template).toBe('ledger')
    expect(card.fields.find((field) => field.label === '即将扣款')?.value).toBe('1 项 · 7 天内共 ¥35.00')
    expect(card.table?.headers).toEqual(['即将扣款', '金额', '扣款日'])
    expect(card.table?.rows[0]).toEqual(['视频会员', '¥35.00', '11-16（2 天后）'])
    expect(card.note).toBe('基于近 30 天 42 笔流水 · 生成于 2023-11-14')
  })

  it('待执行帧不带块（还没有数据）', () => {
    const frames = project(callAndResult().slice(0, 3))
    const pending = cardOf(frames.filter((entry) => entry.kind === 'tool').at(-1))

    expect(pending.fields.some((field) => field.label === '即将扣款')).toBe(false)
  })

  it('失败结果不带块（这次没读到，不拿上次的清单充数）', () => {
    const events = callAndResult()
    const failed = { ...events[3], data: { ...(events[3]?.data as object), isError: true, code: 'bank-failed' } }
    const card = cardOf(project([...events.slice(0, 3), failed]).filter((entry) => entry.kind === 'tool').at(-1))

    expect(card.fields.some((field) => field.label === '即将扣款')).toBe(false)
  })

  it('只有 sub_list 挂块：同 turn 的其它订阅工具成功卡不沾清单（避免张冠李戴）', () => {
    const events = [
      ...callAndResult().slice(0, 2),
      {
        seq: 5,
        at: T0,
        formatVersion: 1,
        type: 'tool/call',
        data: { callId: 'call-cancel', name: 'sub_cancel', args: {}, fingerprint: 'z', tier: { level: 'yellow' }, at: T0 },
      },
      {
        seq: 6,
        at: T0,
        formatVersion: 1,
        type: 'tool/result',
        data: {
          callId: 'call-cancel',
          name: 'sub_cancel',
          isError: false,
          content: [{ type: 'text', text: '已取消' }],
          durationMs: 0,
        },
      },
    ]
    const card = cardOf(project(events).filter((entry) => entry.kind === 'tool' && entry.callId === 'call-cancel')[0])

    expect(card.fields.some((field) => field.label === '即将扣款')).toBe(false)
    expect(card.table).toBeUndefined()
    expect(card.note).toBeUndefined()
  })

  it('跨 turn 不复用上一轮的快照', () => {
    const events = [
      ...callAndResult(),
      { seq: 5, at: T0 + DAY, formatVersion: 1, type: 'turn/start', data: { turn: 2 } },
      {
        seq: 6,
        at: T0 + DAY,
        formatVersion: 1,
        type: 'tool/call',
        data: { callId: 'call-sub-2', name: 'sub_list', args: {}, fingerprint: 'y', tier: { level: 'green' }, at: T0 + DAY },
      },
      {
        seq: 7,
        at: T0 + DAY,
        formatVersion: 1,
        type: 'tool/result',
        data: {
          callId: 'call-sub-2',
          name: 'sub_list',
          isError: false,
          content: [{ type: 'text', text: '订阅 1 项' }],
          durationMs: 0,
        },
      },
    ]
    const frames = project(events)
    const second = cardOf(frames.filter((entry) => entry.kind === 'tool' && entry.callId === 'call-sub-2')[0])

    expect(second.fields.some((field) => field.label === '即将扣款')).toBe(false)
  })
})
