/**
 * 内核·审计轨迹用例（施工单 10 §3 组件 7）。
 * 源用例：`tests/kernel.test.js` 的 trace 段 2 条全量搬迁（分桶互不挤占 / 攒批保序且幂等）；
 * 落盘面由 `appendFileSync` 改为注入 sink，故另补：无 sink、sink 抛错计数、缺省会话桶、
 * 计数指标自增与时间戳来自注入时钟。
 */

import { describe, expect, it } from 'vitest'

import { TraceLog } from './trace.ts'

/** 固定时刻：所有断言都能钉住 ts 字面量。 */
const AT = Date.parse('2026-10-19T08:00:00.000Z')
const TS = '2026-10-19T08:00:00.000Z'

describe('TraceLog·环缓冲按会话分桶', () => {
  it('互不挤占（源用例：ringSize 2）', () => {
    const trace = new TraceLog({ ringSize: 2, now: () => AT })
    trace.append({ session: 'a', kind: 'x', n: 1 })
    trace.append({ session: 'b', kind: 'x', n: 2 })
    trace.append({ session: 'a', kind: 'x', n: 3 })
    trace.append({ session: 'a', kind: 'x', n: 4 })

    expect(trace.recent(10, 'a').map((record) => record.n)).toEqual([3, 4])
    expect(trace.recent(10, 'b').map((record) => record.n)).toEqual([2])
    expect(trace.recent(10).map((record) => record.n)).toEqual([2, 3, 4])
    expect(trace.seq).toBe(4)
  })

  it('序号跨会话单调，作为对账锚点', () => {
    const trace = new TraceLog({ now: () => AT })
    expect(trace.append({ session: 'a', kind: 'x' })).toEqual({ ts: TS, seq: 1, session: 'a', kind: 'x' })
    expect(trace.append({ session: 'b', kind: 'y' })).toEqual({ ts: TS, seq: 2, session: 'b', kind: 'y' })
    expect(trace.recent(10).map((record) => record.seq)).toEqual([1, 2])
  })

  it('缺省会话与空串会话都归到 unknown 桶', () => {    const trace = new TraceLog()
    trace.append({ kind: 'no-session' })
    trace.append({ session: '', kind: 'empty-session' })
    expect([...trace.rings.keys()]).toEqual(['unknown'])
    expect(trace.recent(10, 'unknown').map((record) => record.kind)).toEqual(['no-session', 'empty-session'])
    // 不注入时钟时走 Date.now：ts 必须是可回读的 ISO 串
    const ts = trace.recent(1, 'unknown')[0]?.ts as string
    expect(new Date(ts).toISOString()).toBe(ts)
    expect(trace.flush()).toBe(0) // 无 sink：没有待落盘缓冲
  })

  it('未登记的会话读取为空清单', () => {
    const trace = new TraceLog({ now: () => AT })
    trace.append({ session: 'a', kind: 'x' })
    expect(trace.recent(10, 'zz')).toEqual([])
  })
})

describe('TraceLog·攒批落盘（注入 sink）', () => {
  it('flushThreshold 攒批且保序，flush 幂等', () => {
    const lines: string[] = []
    const trace = new TraceLog({ sink: (batch) => lines.push(...batch), flushThreshold: 3, now: () => AT })

    trace.append({ session: 'a', kind: 'x', n: 1 })
    trace.append({ session: 'a', kind: 'x', n: 2 })
    expect(lines).toEqual([])
    expect(trace.flush()).toBe(2) // 不足阈值 → 手动 flush 兜底
    expect(trace.flush()).toBe(0) // 幂等

    trace.append({ session: 'a', kind: 'x', n: 3 })
    trace.append({ session: 'a', kind: 'x', n: 4 })
    trace.append({ session: 'a', kind: 'x', n: 5 }) // 达阈值自动落盘

    expect(lines).toHaveLength(5)
    expect(lines.map((line) => JSON.parse(line).n)).toEqual([1, 2, 3, 4, 5])
    expect(lines[0]).toBe(`{"ts":"${TS}","seq":1,"session":"a","kind":"x","n":1}`)
  })

  it('阈值 1（缺省）= 每条立即落盘', () => {
    const batches: string[][] = []
    const trace = new TraceLog({ sink: (batch) => batches.push([...batch]), now: () => AT })
    trace.append({ session: 'a', kind: 'x' })
    trace.append({ session: 'a', kind: 'y' })
    expect(batches).toEqual([
      [`{"ts":"${TS}","seq":1,"session":"a","kind":"x"}`],
      [`{"ts":"${TS}","seq":2,"session":"a","kind":"y"}`],
    ])
  })

  it('落盘失败不中断主链路：计入 sinkErrors，不静默冒充成功', () => {
    let calls = 0
    const trace = new TraceLog({
      flushThreshold: 2,
      now: () => AT,
      sink: () => {
        calls += 1
        throw new Error('disk full')
      },
    })
    trace.append({ session: 's', kind: 'k', n: 1 })
    expect(calls).toBe(0)
    const record = trace.append({ session: 's', kind: 'k', n: 2 })
    expect(calls).toBe(1)
    expect(record.seq).toBe(2)
    expect(trace.counters.sinkErrors).toBe(2)
    expect(trace.recent(5, 's').map((item) => item.n)).toEqual([1, 2])
    expect(trace.flush()).toBe(0) // 失败批次已消费，不重复记账
  })
})

describe('TraceLog·计数指标', () => {
  it('bump 缺省步长 1，可指定增量', () => {
    const trace = new TraceLog()
    expect(trace.counters).toEqual({
      detections: 0,
      denies: 0,
      asks: 0,
      allows: 0,
      pii: 0,
      ticketsIssued: 0,
      ticketsConsumed: 0,
      breakerTrips: 0,
      escalations: 0,
      sinkErrors: 0,
      observerErrors: 0,
    })
    trace.bump('detections')
    trace.bump('ticketsIssued', 3)
    trace.bump('sinkErrors')
    expect(trace.counters.detections).toBe(1)
    expect(trace.counters.ticketsIssued).toBe(3)
    expect(trace.counters.sinkErrors).toBe(1)
    expect(trace.counters.allows).toBe(0)
  })

  it('recent 的 n 生效于跨会话合并后的尾部截取', () => {
    const trace = new TraceLog({ now: () => AT })
    for (let index = 0; index < 5; index += 1) trace.append({ session: `s${index % 2}`, kind: 'x', n: index })
    expect(trace.recent(2).map((record) => record.n)).toEqual([3, 4])
    expect(trace.recent(1, 's0').map((record) => record.n)).toEqual([4])
    expect(trace.recent(10, 's0').map((record) => record.n)).toEqual([0, 2, 4])
  })
})

describe('TraceLog·会话桶 LRU', () => {
  it('超过 maxSessions 淘汰最久未写入的桶，命中即刷新', () => {
    const trace = new TraceLog({ maxSessions: 2, now: () => AT })
    trace.append({ session: 'a', kind: 'x' })
    trace.append({ session: 'b', kind: 'x' })
    trace.append({ session: 'a', kind: 'x' })
    trace.append({ session: 'c', kind: 'x' })

    expect([...trace.rings.keys()]).toEqual(['a', 'c'])
  })
})
