import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { createFactStore, replayFacts } from './store.ts'
import { createFactTools } from './tool.ts'

import type { AnySessionEvent } from '../session/types.ts'
import type { LifeFact } from './types.ts'

const NOW = 1_761_200_000_000

function store(): { store: ReturnType<typeof createFactStore>; ids: string[] } {
  let seq = 0
  const ids: string[] = []
  return {
    store: createFactStore({
      nextId: () => {
        seq += 1
        const id = `f-${String(seq)}`
        ids.push(id)
        return id
      },
    }),
    ids,
  }
}

function resultEvent(name: string, payload: unknown, seq = 1): AnySessionEvent {
  return {
    seq,
    at: seq,
    formatVersion: 1,
    type: 'tool/result',
    data: {
      callId: `call-${String(seq)}`,
      name,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
  } as AnySessionEvent
}

describe('FactStore', () => {
  it('新建事实：version=1、confirmed 缺省 false、sourceTurn 注入', () => {
    const { store: facts } = store()
    const fact = facts.remember(
      { person: '爱人', relation: 'spouse', kind: 'birthday', date: '1990-10-24' },
      NOW,
      3,
    )
    expect(fact.factId).toBe('f-1')
    expect(fact.version).toBe(1)
    expect(fact.confirmed).toBe(false)
    expect(fact.sourceTurn).toBe(3)
  })

  it('同一人物+关系+种类+日期 ⇒ 再确认（version+1，confirmed 变 true，id 不变）', () => {
    const { store: facts } = store()
    const first = facts.remember({ person: '爱人', relation: 'spouse', kind: 'birthday', date: '1990-10-24' }, NOW, 1)
    const second = facts.remember(
      { person: '爱人', relation: 'spouse', kind: 'birthday', date: '1990-10-24', confirmed: true },
      NOW + 1,
      2,
    )
    expect(second.factId).toBe(first.factId)
    expect(second.version).toBe(2)
    expect(second.confirmed).toBe(true)
    expect(facts.versions()).toEqual({ 'f-1': 2 })
  })

  it('list 过滤与 forget 删除（删除后版本表里也不存在）', () => {
    const { store: facts } = store()
    facts.remember({ person: '母亲', relation: 'parent', kind: 'birthday', date: '1960-01-01' }, NOW, 1)
    facts.remember({ person: '爱人', relation: 'spouse', kind: 'preference', note: '不喜欢百合' }, NOW, 2)
    expect(facts.list({ person: '爱人' })).toHaveLength(1)
    expect(facts.list({ kind: 'birthday' })).toHaveLength(1)

    const removed = facts.forget('f-2')
    expect(removed.factId).toBe('f-2')
    expect(facts.list()).toHaveLength(1)
    expect(facts.versions()).toEqual({ 'f-1': 1 })
    expect(captureThrown(() => facts.forget('f-2')).code).toBe('fact-unknown')
  })

  it('上限 fail-loud；坏输入 fail-loud', () => {
    const { store: facts } = store()
    expect(
      captureThrown(() =>
        facts.remember({ person: '', relation: 'self', kind: 'preference' }, NOW, 1),
      ).code,
    ).toBe('fact-invalid')
    expect(
      captureThrown(() =>
        facts.remember(
          { person: '我', relation: 'self', kind: 'birthday', date: '10月24日' },
          NOW,
          1,
        ),
      ).code,
    ).toBe('fact-invalid')
    expect(
      captureThrown(() =>
        facts.remember(
          { person: '我', relation: 'self', kind: 'preference', note: 'x'.repeat(201) },
          NOW,
          1,
        ),
      ).code,
    ).toBe('fact-invalid')
  })

  it('重放与在线账本一致（含删除）', () => {
    const { store: facts } = store()
    const first = facts.remember({ person: '爱人', relation: 'spouse', kind: 'birthday', date: '1990-10-24' }, NOW, 1)
    const second = facts.remember(
      { person: '爱人', relation: 'spouse', kind: 'birthday', date: '1990-10-24', confirmed: true },
      NOW,
      2,
    )
    const removed = facts.remember({ person: '母亲', relation: 'parent', kind: 'birthday', date: '1960-01-01' }, NOW, 3)
    facts.forget(removed.factId)
    const events = [
      resultEvent('fact_remember', first, 1),
      resultEvent('fact_remember', second as LifeFact, 2),
      resultEvent('fact_remember', removed, 3),
      resultEvent('fact_forget', { factId: removed.factId, deleted: true }, 4),
    ]
    const replayed = replayFacts(events, { nextId: () => 'f-new' })
    expect(replayed.list()).toEqual(facts.list())
    expect(replayed.versions()).toEqual(facts.versions())
  })

  it('重放遇坏 JSON fail-loud', () => {
    const bad = {
      ...resultEvent('fact_remember', {}, 1),
      data: {
        callId: 'c1',
        name: 'fact_remember',
        isError: false,
        content: [{ type: 'text', text: '{' }],
      },
    } as AnySessionEvent
    expect(captureThrown(() => replayFacts([bad], { nextId: () => 'x' })).code).toBe('fact-replay-invalid')
  })
})

describe('FactTools', () => {
  const ctx = {
    sessionId: 's-1' as never,
    callId: 'call-1',
    signal: new AbortController().signal,
  }

  it('三工具齐备：fact_remember（绿/写）、fact_list（绿/读）、fact_forget（黄/写）', () => {
    const { store: facts } = store()
    const tools = createFactTools(facts, { turnOf: () => 7, now: () => NOW })
    expect(tools.map((tool) => tool.name)).toEqual(['fact_remember', 'fact_list', 'fact_forget'])
    expect(tools.map((tool) => tool.tier.level)).toEqual(['green', 'green', 'yellow'])
    expect(tools.map((tool) => tool.sideEffect)).toEqual(['write', 'none', 'write'])
  })

  it('fact_remember 经工具写入时 sourceTurn 来自注入', async () => {
    const { store: facts } = store()
    const [remember] = createFactTools(facts, { turnOf: () => 9, now: () => NOW })
    const result = await (remember as { execute: (args: unknown, ctx: unknown) => Promise<LifeFact> }).execute(
      { person: '爱人', relation: 'spouse', kind: 'birthday', date: '1990-10-24', confirmed: true },
      ctx,
    )
    expect(result.sourceTurn).toBe(9)
    expect(result.confirmed).toBe(true)
  })

  it('fact_forget 缺 factId 即抛', async () => {
    const { store: facts } = store()
    const [, , forget] = createFactTools(facts, { turnOf: () => 1, now: () => NOW })
    const execute = (forget as { execute: (args: unknown, ctx: unknown) => Promise<unknown> }).execute
    await expect(execute({}, ctx)).rejects.toMatchObject({ code: 'fact-invalid' })
  })
})
