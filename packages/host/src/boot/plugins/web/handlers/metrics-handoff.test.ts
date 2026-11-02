/**
 * 人工接管的指标派生（`handlers/metrics-handoff.ts`）。
 *
 * 该文件是最近合并进来的"两层真相源"实现：历史计数从会话事件现算，
 * `active` 从状态机读。三条最容易被改坏的性质：
 * 1. **配对才算时长**：只有 `requested → resumed` 成对出现才产出 `lastWaitedMs`，
 *    孤立的 resumed 不能凭空造出一个等待时长；
 * 2. **消费边界**：`ingest` 只认 `handoff/*`，返回 false 的事件必须继续留给主循环，
 *    否则一次接管会把后面的 turn/tool 统计吞掉；
 * 3. **未配 SLA 是 null 而不是 0**（0 的含义是"配了但不告警"）。
 */

import { describe, expect, it } from 'vitest'

import { createHandoffMetrics, type HandoffMetricEvent } from './metrics-handoff.ts'

function event(type: string, at: number): HandoffMetricEvent {
  return { type, at }
}

/** 一次跑完累积器并取快照（调用方只关心输入与输出）。 */
function run(
  events: readonly HandoffMetricEvent[],
  source: { active: boolean; slaMs: number } = { active: false, slaMs: 0 },
): ReturnType<ReturnType<typeof createHandoffMetrics>['snapshot']> {
  const accumulator = createHandoffMetrics(source)
  for (const item of events) accumulator.ingest(item)
  return accumulator.snapshot()
}

describe('createHandoffMetrics · 计数与状态', () => {
  it('空事件：各项为 0，active 取状态机，slaMs=0 记 null', () => {
    expect(run([], { active: true, slaMs: 0 })).toEqual({
      active: true,
      entered: 0,
      resumed: 0,
      operatorMessages: 0,
      timeoutWarned: 0,
      lastWaitedMs: null,
      slaMs: null,
    })
  })

  it('配了 SLA：原样透出（0 才表示"只记录不告警"）', () => {
    expect(run([], { active: true, slaMs: 180_000 }).slaMs).toBe(180_000)
  })

  it('四类事件各计各的（不会串账）', () => {
    const snapshot = run([
      event('handoff/requested', 100),
      event('handoff/operator-message', 110),
      event('handoff/operator-message', 120),
      event('handoff/timeout-warned', 130),
    ])
    expect(snapshot).toMatchObject({
      entered: 1,
      resumed: 0,
      operatorMessages: 2,
      timeoutWarned: 1,
      // 没有 resumed 就没有配对时长（不猜）
      lastWaitedMs: null,
    })
  })
})

describe('createHandoffMetrics · 等待时长只认成对事件', () => {
  it('requested → resumed 产出差值', () => {
    expect(run([event('handoff/requested', 1_000), event('handoff/resumed', 61_000)]).lastWaitedMs).toBe(60_000)
  })

  it('孤立的 resumed 不产出时长', () => {
    expect(run([event('handoff/resumed', 5_000)]).lastWaitedMs).toBeNull()
  })

  it('一次 enter 只配对一次：第二次 resumed 不重复计时', () => {
    const snapshot = run([
      event('handoff/requested', 1_000),
      event('handoff/resumed', 2_000),
      event('handoff/resumed', 9_000),
    ])
    expect(snapshot.lastWaitedMs).toBe(1_000)
    expect(snapshot.resumed).toBe(2)
  })

  it('后一次接管覆盖前一次的时长（保留最近一次）', () => {
    const snapshot = run([
      event('handoff/requested', 1_000),
      event('handoff/resumed', 3_000),
      event('handoff/requested', 10_000),
      event('handoff/resumed', 12_500),
    ])
    expect(snapshot.lastWaitedMs).toBe(2_500)
  })

  it('时钟回拨不让时长为负', () => {
    expect(run([event('handoff/requested', 2_000), event('handoff/resumed', 1_000)]).lastWaitedMs).toBe(0)
  })
})

describe('createHandoffMetrics · 消费边界', () => {
  it('handoff/* 一律返回 true（调用方 continue）', () => {
    for (const type of [
      'handoff/requested',
      'handoff/resumed',
      'handoff/operator-message',
      'handoff/timeout-warned',
    ]) {
      const accumulator = createHandoffMetrics({ active: true, slaMs: 0 })
      expect(accumulator.ingest(event(type, 1))).toBe(true)
    }
  })

  it('非 handoff 事件返回 false（不能被接管累积器吞掉）', () => {
    const accumulator = createHandoffMetrics({ active: false, slaMs: 0 })
    expect(accumulator.ingest(event('turn/end', 1))).toBe(false)
    expect(accumulator.snapshot()).toMatchObject({
      entered: 0,
      resumed: 0,
      operatorMessages: 0,
      timeoutWarned: 0,
    })
  })
})
