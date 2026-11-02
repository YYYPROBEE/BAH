import { describe, expect, it } from 'vitest'

import { DEFAULT_NOTIFY_BUDGET, deriveNotify, inQuietHours } from './policy.ts'

import type { NotifyHistoryItem } from './policy.ts'

/** 2026-10-22 10:00 +08:00 */
const MORNING = Date.UTC(2026, 9, 22, 2, 0, 0)
const HOUR = 3_600_000

function history(entries: readonly { at: number; priority?: 'exec' | 'decision' | 'alert'; key?: string }[]): NotifyHistoryItem[] {
  return entries.map((entry) => ({
    at: entry.at,
    priority: entry.priority ?? 'exec',
    ...(entry.key === undefined ? {} : { key: entry.key }),
  }))
}

describe('inQuietHours', () => {
  it('跨零点时段：[22,8) 含 22 与 7，不含 8 与 21', () => {
    expect(inQuietHours(22, [22, 8])).toBe(true)
    expect(inQuietHours(7, [22, 8])).toBe(true)
    expect(inQuietHours(8, [22, 8])).toBe(false)
    expect(inQuietHours(21, [22, 8])).toBe(false)
  })

  it('同起止 = 不设静默', () => {
    expect(inQuietHours(3, [5, 5])).toBe(false)
  })

  it('非跨零点时段 [12,14)：含 12 与 13，不含 11 与 14', () => {
    expect(inQuietHours(12, [12, 14])).toBe(true)
    expect(inQuietHours(13, [12, 14])).toBe(true)
    expect(inQuietHours(11, [12, 14])).toBe(false)
    expect(inQuietHours(14, [12, 14])).toBe(false)
  })
})

describe('deriveNotify：预算可配置，判定沿用同一套边界', () => {
  it('非跨零点静默时段对 decision 生效，alert 仍照发', () => {
    const budget = { dailyCap: 6, quietHours: [12, 14] as const, minGapMs: 5 * 60 * 1000 }
    const noon = Date.UTC(2026, 9, 22, 4, 0) // 12:00 +08
    expect(deriveNotify([], { priority: 'decision', at: noon }, budget).reason).toBe('quiet-hours')
    expect(deriveNotify([], { priority: 'alert', at: noon }, budget).send).toBe(true)
  })
})

describe('deriveNotify：三档 + 上限 + 静默 + 去重', () => {
  it('白天无历史 ⇒ ok（in-app）', () => {
    expect(deriveNotify([], { priority: 'exec', at: MORNING })).toEqual({
      send: true,
      channel: 'in-app',
      reason: 'ok',
    })
  })

  it('23:59 静默（exec / decision 都被拦）', () => {
    const late = Date.UTC(2026, 9, 22, 15, 59) // 23:59 +08
    expect(deriveNotify([], { priority: 'exec', at: late }).reason).toBe('quiet-hours')
    expect(deriveNotify([], { priority: 'decision', at: late }).reason).toBe('quiet-hours')
  })

  it('08:00 边界放行', () => {
    const eight = Date.UTC(2026, 9, 22, 0, 0) // 08:00 +08
    expect(deriveNotify([], { priority: 'decision', at: eight }).send).toBe(true)
  })

  it('alert 不受静默与日上限限制（只去重）', () => {
    const late = Date.UTC(2026, 9, 22, 15, 59)
    expect(deriveNotify([], { priority: 'alert', at: late }).send).toBe(true)
    const many = history(Array.from({ length: 20 }, (_, index) => ({ at: MORNING - index * 1000 })))
    expect(deriveNotify(many, { priority: 'alert', at: MORNING }).send).toBe(true)
  })

  it('日上限：第 7 条 exec 被拦；跨日重置', () => {
    const many = history(
      Array.from({ length: 6 }, (_, index) => ({ at: MORNING - index * 10 * 60 * 1000 })),
    )
    expect(deriveNotify(many, { priority: 'exec', at: MORNING }).reason).toBe('daily-cap')
    // 次日 10:00 重新计数
    expect(deriveNotify(many, { priority: 'exec', at: MORNING + 24 * HOUR }).send).toBe(true)
  })

  it('连续 5 条 exec：最小间隔内只发第 1 条', () => {
    const sent: NotifyHistoryItem[] = []
    for (let index = 0; index < 5; index += 1) {
      const at = MORNING + index * 60_000
      const decision = deriveNotify(sent, { priority: 'exec', at })
      if (decision.send) sent.push({ at, priority: 'exec' })
    }
    expect(sent).toHaveLength(1)
  })

  it('去重：同 key 在去重窗口内 ⇒ dedup（窗口外可再发）', () => {
    const past = history([{ at: MORNING - 60_000, key: 'plan:p-1:2026-10-22' }])
    expect(
      deriveNotify(past, { priority: 'decision', at: MORNING, key: 'plan:p-1:2026-10-22' }).reason,
    ).toBe('dedup')
    expect(
      deriveNotify(past, {
        priority: 'decision',
        at: MORNING + DEFAULT_NOTIFY_BUDGET.minGapMs,
        key: 'plan:p-1:2026-10-22',
      }).send,
    ).toBe(true)
  })
})
