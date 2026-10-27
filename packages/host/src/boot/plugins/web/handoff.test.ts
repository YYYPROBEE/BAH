/**
 * 人工接管状态机（C5）单测。
 *
 * 钉住四件事：
 * 1. 状态转移只看"进入 / 交回"两个动作，重复请求不刷新进入时间；
 * 2. 摘要只带最近若干条原话，**排除 `runtime-context`**（系统注入不是人说的话）；
 * 3. 两个事件按 `appendDomain` 的载荷逐字落账（审计可回放）；
 * 4. 交回后 `active` 立刻为 false（`/api/turn` 的同一次请求就能恢复可用）。
 */

import { describe, expect, it } from 'vitest'

import { HandoffRegistry, type HandoffSummary } from './handoff.ts'

import type { AnySessionEvent, SessionApi } from '@bah/runtime'

interface Harness {
  readonly handoff: HandoffRegistry
  readonly events: { type: string; data: Record<string, unknown> }[]
  readonly setEvents: (next: readonly AnySessionEvent[]) => void
  readonly setPending: (count: number) => void
}

function harness(options: { sessionId?: string; now?: () => number } = {}): Harness {
  let events: readonly AnySessionEvent[] = []
  let pending = 0
  const appended: { type: string; data: Record<string, unknown> }[] = []
  const session = {
    sessionId: options.sessionId ?? 's-handoff',
    lastSeq: () => (events.at(-1)?.seq ?? 0),
    events: () => events,
  } as unknown as SessionApi
  const handoff = new HandoffRegistry({
    session,
    now: options.now ?? (() => 1_792_000_000_000),
    append: (type, data) => {
      appended.push({ type, data })
    },
    pendingTickets: () => pending,
  })
  return {
    handoff,
    events: appended,
    setEvents: (next) => {
      events = next
    },
    setPending: (count) => {
      pending = count
    },
  }
}

/** 造一对 user/assistant 事件（seq 连续）。 */
function turn(seq: number, user: string, assistant: string, source?: string): AnySessionEvent[] {
  return [
    {
      seq,
      at: 1,
      formatVersion: 1,
      type: 'user/message',
      data: { content: user, ...(source === undefined ? {} : { source }) },
    },
    {
      seq: seq + 1,
      at: 1,
      formatVersion: 1,
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: assistant }] },
    },
    { seq: seq + 2, at: 1, formatVersion: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as AnySessionEvent[]
}

describe('C5 人工接管状态机', () => {
  it('进入 → active；重复进入 409 语义且不刷新进入时间', () => {
    const h = harness()
    expect(h.handoff.active).toBe(false)

    const first = h.handoff.enter('客户要求人工')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.summary.active).toBe(true)
    expect(first.summary.reason).toBe('客户要求人工')
    expect(first.summary.at).toBe(1_792_000_000_000)

    const again = h.handoff.enter('第二次点')
    expect(again).toEqual({ ok: false, code: 'handoff-already-active' })
    // `at` 仍是第一次的时间：运维看"已等多久"不能因为重复点击而清零
    expect(h.handoff.summary().at).toBe(1_792_000_000_000)
    expect(h.events).toHaveLength(1)
  })

  it('交回 → active 立刻为 false，并落 `handoff/resumed`（带 operator）', () => {
    const h = harness()
    h.handoff.enter()
    const resumed = h.handoff.resume('坐席-A')
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.summary.active).toBe(false)
    expect(resumed.summary.operator).toBe('坐席-A')
    expect(h.handoff.active).toBe(false)
    expect(h.events.map((event) => event.type)).toEqual(['handoff/requested', 'handoff/resumed'])
  })

  it('未接管时交回 → handoff-not-active（不做幂等成功）', () => {
    const h = harness()
    expect(h.handoff.resume(undefined)).toEqual({ ok: false, code: 'handoff-not-active' })
    expect(h.events).toEqual([])
  })

  it('摘要：最近若干条原话、排除 runtime-context、单条截断', () => {
    const h = harness()
    h.setPending(2)
    const long = '很长的句子'.repeat(60)
    h.setEvents([
      ...turn(1, '给王建国转 800 元', '已提交审批'),
      ...turn(4, '为什么被拒了？', '因为超过日限额'),
      ...turn(7, '补充说明', '好的', 'runtime-context'),
    ])

    const summary: HandoffSummary = h.handoff.summary()
    expect(summary.active).toBe(false)
    expect(summary.sessionId).toBe('s-handoff')
    expect(summary.lastSeq).toBe(9)
    expect(summary.turns).toBe(3)
    expect(summary.pendingTickets).toBe(2)
    // runtime-context 那条不算用户原话
    expect(summary.messages.map((item) => item.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'assistant',
    ])
    expect(summary.messages[0]?.text).toBe('给王建国转 800 元')

    // 截断：内容超长时以省略号收尾，且长度有上限
    h.setEvents(turn(1, long, '好'))
    const truncated = h.handoff.summary().messages[0]?.text ?? ''
    expect(truncated.endsWith('…')).toBe(true)
    expect([...truncated].length).toBeLessThanOrEqual(201)
  })

  it('摘要最多带 6 条（再多人工侧读不完，也不该把会话摊开）', () => {
    const h = harness()
    const many: AnySessionEvent[] = []
    for (let index = 0; index < 10; index += 1) {
      many.push(...turn(index * 3 + 1, `第 ${String(index)} 句`, `回 ${String(index)}`))
    }
    h.setEvents(many)
    expect(h.handoff.summary().messages).toHaveLength(6)
  })
})
