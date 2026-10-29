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

import { captureThrown } from '@bah/test-support'

import { HandoffRegistry, type HandoffSummary } from './handoff.ts'
import type { HandoffSnapshot } from './handoff-store.ts'

import type { AnySessionEvent, SessionApi } from '@bah/runtime'

interface Harness {
  readonly handoff: HandoffRegistry
  readonly events: { type: string; data: Record<string, unknown> }[]
  /** `appendDomain` 收到的事件（人工发言等）。 */
  readonly domain: { type: string; data: Record<string, unknown> }[]
  /** `append('user/message', …)` 收到的载荷（交接语）。 */
  readonly userMessages: { content: string; source?: string }[]
  readonly setEvents: (next: readonly AnySessionEvent[]) => void
  readonly setPending: (count: number) => void
}

function harness(options: { sessionId?: string; now?: () => number; slaMs?: number } = {}): Harness {
  let events: readonly AnySessionEvent[] = []
  let pending = 0
  const appended: { type: string; data: Record<string, unknown> }[] = []
  const domain: { type: string; data: Record<string, unknown> }[] = []
  const userMessages: { content: string; source?: string }[] = []
  const now = options.now ?? (() => 1_792_000_000_000)

  const pushEvent = (type: string, data: Record<string, unknown>): AnySessionEvent => {
    const seq = (events.at(-1)?.seq ?? 0) + 1
    const event = { seq, at: now(), formatVersion: 1, type, data } as unknown as AnySessionEvent
    events = [...events, event]
    return event
  }

  const session = {
    sessionId: options.sessionId ?? 's-handoff',
    lastSeq: () => (events.at(-1)?.seq ?? 0),
    events: () => events,
    appendDomain: (type: string, data: Record<string, unknown>) => {
      domain.push({ type, data })
      return pushEvent(type, data)
    },
    append: (type: string, data: { content: string; source?: string }) => {
      userMessages.push(data)
      return pushEvent(type, data)
    },
  } as unknown as SessionApi
  const handoff = new HandoffRegistry({
    session,
    now,
    append: (type, data) => {
      appended.push({ type, data })
    },
    pendingTickets: () => pending,
    ...(options.slaMs === undefined ? {} : { slaMs: options.slaMs }),
  })
  return {
    handoff,
    events: appended,
    domain,
    userMessages,
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

  it('交回 → active 立刻为 false，并落 `handoff/resumed`（带 operatorId + label）', () => {
    const h = harness()
    h.handoff.enter()
    const resumed = h.handoff.resume('u-ops-a', undefined, '坐席-A')
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.summary.active).toBe(false)
    expect(resumed.summary.operator).toBe('坐席-A')
    expect(resumed.summary.operatorId).toBe('u-ops-a')
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

  it('TA-45 进入时记录 requestedBy（来自服务端派生的主体）', () => {
    const h = harness()
    h.handoff.enter('客户要求人工', 'u-1')
    expect(h.events[0]).toMatchObject({
      type: 'handoff/requested',
      data: { reason: '客户要求人工', requestedBy: 'u-1' },
    })
  })
})

describe('人机接管 01：认领 / 发言 / 心跳 / 恢复', () => {
  const persistentStore = (): {
    load: () => HandoffSnapshot | undefined
    save: (snapshot: HandoffSnapshot) => void
    clear: () => void
  } => {
    let snapshot: HandoffSnapshot | undefined
    return {
      load: () => snapshot,
      save: (next) => {
        snapshot = next
      },
      clear: () => {
        snapshot = undefined
      },
    }
  }

  it('T-07 enter 落盘失败 → handoff-state-unwritable，且状态未 active', () => {
    const h = harness()
    const broken = new HandoffRegistry({
      session: { sessionId: 's', lastSeq: () => 0, events: () => [] } as unknown as SessionApi,
      now: () => 1,
      append: () => undefined,
      pendingTickets: () => 0,
      store: {
        load: () => undefined,
        save: () => {
          throw new Error('disk full')
        },
        clear: () => undefined,
      },
    })
    const error = captureThrown(() => broken.enter())
    expect((error as { code?: string }).code).toBe('handoff-state-unwritable')
    expect(broken.active).toBe(false)
    // 原来的装置不受影响（用例互相独立）
    expect(h.handoff.active).toBe(false)
  })

  it('T-09/T-10/T-11 claim：同一人幂等、换人 409、认领事件带 enteredAt', () => {
    let clock = 1_000
    const h = harness({ now: () => clock })
    h.handoff.enter('客户要求人工')

    clock = 2_000
    const first = h.handoff.claim('u-ops-a', '坐席-A')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.summary.claimed).toBe(true)
    expect(first.summary.operator).toBe('坐席-A')
    expect(first.summary.operatorId).toBe('u-ops-a')
    const claimed = h.events.find((event) => event.type === 'handoff/claimed')
    expect(claimed?.data['enteredAt']).toBe(1_000)
    expect(claimed?.data['at']).toBe(2_000)
    // 换人判定用 userId（显示名只是标签）
    expect(claimed?.data['operatorId']).toBe('u-ops-a')

    // 同一人重复认领：幂等，不落第二条事件，`at` 不变
    clock = 3_000
    expect(h.handoff.claim('u-ops-a', '坐席-A').ok).toBe(true)
    expect(h.events.filter((event) => event.type === 'handoff/claimed')).toHaveLength(1)
    expect(h.handoff.summary().at).toBe(1_000)

    const other = h.handoff.claim('u-ops-b', '坐席-B')
    expect(other).toEqual({ ok: false, code: 'handoff-claimed-by-other' })
  })

  it('T-12/T-13/T-14/T-15 say：落领域事件、空串拒绝、2000 字符上限、未接管拒绝', () => {
    const h = harness()
    expect(h.handoff.say('A', '在吗')).toEqual({ ok: false, code: 'handoff-not-active' })

    h.handoff.enter()
    expect(h.handoff.say('A', '   ')).toEqual({ ok: false, code: 'handoff-text-empty' })
    expect(h.domain).toHaveLength(0)

    const said = h.handoff.say('A', '您好，我是人工坐席')
    expect(said.ok).toBe(true)
    if (!said.ok) return
    const event = h.domain.find((item) => item.type === 'handoff/operator-message')
    expect(event?.data).toMatchObject({ text: '您好，我是人工坐席', operator: 'A' })
    expect(said.seq).toBeGreaterThan(0)

    // 字符数不是字节数：2001 个 emoji 才算超长，2000 个刚好通过
    expect(h.handoff.say('A', '😀'.repeat(2001))).toEqual({
      ok: false,
      code: 'handoff-text-too-long',
    })
    expect(h.handoff.say('A', '😀'.repeat(2000)).ok).toBe(true)
  })

  it('T-16/T-17/T-18 resume：交接语进 user/message；无交接语不落；超长拒绝且仍在接管', () => {
    const h = harness()
    h.handoff.enter()
    const resumed = h.handoff.resume('坐席-A', '已核对收款人，继续转账')
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.summary.active).toBe(false)
    expect(h.userMessages).toEqual([
      { content: '已核对收款人，继续转账', source: 'handoff-handover' },
    ])
    expect(h.events.map((event) => event.type)).toEqual(['handoff/requested', 'handoff/resumed'])

    const quiet = harness()
    quiet.handoff.enter()
    expect(quiet.handoff.resume('坐席-A').ok).toBe(true)
    expect(quiet.userMessages).toEqual([])

    const long = harness()
    long.handoff.enter()
    expect(long.handoff.resume('坐席-A', 'x'.repeat(2001))).toEqual({
      ok: false,
      code: 'handoff-text-too-long',
    })
    // 交回失败不能把会话悄悄交回
    expect(long.handoff.active).toBe(true)
  })

  it('T-18 heartbeat：超过 slaMs 落一次 timeout-warned；再调不重复', () => {
    let clock = 1_000
    const h = harness({ now: () => clock, slaMs: 180_000 })
    h.handoff.enter('客户要求人工')
    expect(h.handoff.heartbeat()).toEqual({ waitedMs: 0, overdue: false })

    clock = 1_000 + 180_001
    const first = h.handoff.heartbeat()
    expect(first.overdue).toBe(true)
    expect(first.waitedMs).toBe(180_001)
    expect(h.events.filter((event) => event.type === 'handoff/timeout-warned')).toHaveLength(1)

    clock += 1_000
    expect(h.handoff.heartbeat().overdue).toBe(true)
    expect(h.events.filter((event) => event.type === 'handoff/timeout-warned')).toHaveLength(1)
  })

  it('T-19/T-20 summary：排除 runtime-context 与 handoff-handover，保留 handoff-waiting；未接管形状稳定', () => {
    const h = harness()
    h.handoff.enter()
    h.setEvents([
      {
        seq: 1,
        at: 1,
        formatVersion: 1,
        type: 'user/message',
        data: { content: '客户原话', source: 'user' },
      },
      {
        seq: 2,
        at: 1,
        formatVersion: 1,
        type: 'user/message',
        data: { content: '系统注入的画像', source: 'runtime-context' },
      },
      {
        seq: 3,
        at: 1,
        formatVersion: 1,
        type: 'user/message',
        data: { content: '交接语', source: 'handoff-handover' },
      },
      {
        seq: 4,
        at: 1,
        formatVersion: 1,
        type: 'user/message',
        data: { content: '等待中客户说的', source: 'handoff-waiting' },
      },
    ] as unknown as AnySessionEvent[])
    const summary = h.handoff.summary()
    expect(summary.messages.map((item) => item.text)).toEqual(['客户原话', '等待中客户说的'])
    expect(summary.turnsSinceHandoff).toBe(0)

    const idle = harness()
    expect(idle.handoff.summary()).toMatchObject({
      active: false,
      waitedMs: 0,
      overdue: false,
      claimed: false,
      turnsSinceHandoff: 0,
      operatorMessages: 0,
    })
  })

  it('交回后的摘要仍记得上一次接管的人工发言条数（operatorMessages 的回看口径）', () => {
    const h = harness()
    h.handoff.enter()
    h.handoff.say('A', '第一句')
    h.handoff.say('A', '第二句')
    expect(h.handoff.resume('A').ok).toBe(true)
    const summary = h.handoff.summary()
    expect(summary.active).toBe(false)
    expect(summary.operatorMessages).toBe(2)
  })

  it('T-36 重启恢复：同一落盘端口新建状态机 → active 与 at/reason/operator 原样', () => {
    const store = persistentStore()
    const first = new HandoffRegistry({
      session: { sessionId: 's', lastSeq: () => 5, events: () => [] } as unknown as SessionApi,
      now: () => 10_000,
      append: () => undefined,
      pendingTickets: () => 0,
      store,
    })
    first.enter('客户要求人工')
    first.claim('u-ops-a', '坐席-A')

    const restarted = new HandoffRegistry({
      session: { sessionId: 's', lastSeq: () => 0, events: () => [] } as unknown as SessionApi,
      now: () => 20_000,
      append: () => undefined,
      pendingTickets: () => 0,
      store,
    })
    expect(restarted.active).toBe(true)
    expect(restarted.summary()).toMatchObject({
      active: true,
      at: 10_000,
      reason: '客户要求人工',
      operator: '坐席-A',
      claimed: true,
      // 重启后日志为空：历史计数为 0，不造假（boot 不重放）
      operatorMessages: 0,
    })
    // 等待时长按新进程的 now 与旧 at 算
    expect(restarted.summary().waitedMs).toBe(10_000)
  })
})
