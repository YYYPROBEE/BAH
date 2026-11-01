import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { createFactStore, replayFacts } from './store.ts'
import { createFactTools } from './tool.ts'

import type { AnySessionEvent } from '../session/types.ts'
import { MAX_FACTS, type LifeFact } from './types.ts'

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

  it('坏输入 fail-loud（空人物 / 坏日期 / 超长 note / 非法枚举）', () => {
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
    const rememberLoose = facts.remember as (input: unknown, at: number, turn: number) => unknown
    expect(
      captureThrown(() =>
        rememberLoose({ person: '我', relation: 'friend', kind: 'preference' }, NOW, 1),
      ).code,
    ).toBe('fact-invalid')
    expect(
      captureThrown(() =>
        rememberLoose({ person: '我', relation: 'self', kind: 'gift' }, NOW, 1),
      ).code,
    ).toBe('fact-invalid')
  })

  it('达到 MAX_FACTS 后拒绝新事实，但已有事实的再确认仍可写', () => {
    const { store: facts } = store()
    for (let index = 0; index < MAX_FACTS; index += 1) {
      facts.remember(
        { person: `p-${String(index)}`, relation: 'self', kind: 'preference' },
        NOW,
        1,
      )
    }
    expect(facts.list()).toHaveLength(MAX_FACTS)
    expect(
      captureThrown(() =>
        facts.remember({ person: '溢出', relation: 'self', kind: 'preference' }, NOW, 1),
      ).code,
    ).toBe('fact-limit-exceeded')

    const reconfirmed = facts.remember(
      { person: 'p-0', relation: 'self', kind: 'preference', confirmed: true },
      NOW,
      2,
    )
    expect(reconfirmed).toMatchObject({ factId: 'f-1', version: 2, confirmed: true })
    expect(facts.list()).toHaveLength(MAX_FACTS)
  })

  it('forget 后同身份再记：分配新 id、版本从 1 起（删除关系不残留）', () => {
    const { store: facts } = store()
    const first = facts.remember(
      { person: '爱人', relation: 'spouse', kind: 'preference' },
      NOW,
      1,
    )
    facts.forget(first.factId)
    const again = facts.remember(
      { person: '爱人', relation: 'spouse', kind: 'preference' },
      NOW,
      2,
    )
    expect(again.factId).toBe('f-2')
    expect(again.version).toBe(1)
    expect(facts.list().map((fact) => fact.factId)).toEqual(['f-2'])
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

  it('重放遇缺字段 / 非对象结果 fail-loud（不猜、不跳过）', () => {
    const replay = (payload: unknown): unknown =>
      captureThrown(() =>
        replayFacts([resultEvent('fact_remember', payload)], { nextId: () => 'x' }),
      ).code

    expect(replay({ version: 1, relation: 'spouse', kind: 'birthday' })).toBe('fact-replay-invalid')
    expect(replay({ factId: 'f-1', relation: 'spouse', kind: 'birthday' })).toBe(
      'fact-replay-invalid',
    )
    expect(replay({ factId: 'f-1', version: 1, relation: 'Self', kind: 'birthday' })).toBe(
      'fact-replay-invalid',
    )
    expect(replay({ factId: 'f-1', version: 1, relation: 'spouse', kind: 'gift' })).toBe(
      'fact-replay-invalid',
    )
    expect(replay([])).toBe('fact-replay-invalid')
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

  it('fact_list 把 person / kind 过滤原样透传给账本', async () => {
    const { store: facts } = store()
    facts.remember({ person: '母亲', relation: 'parent', kind: 'birthday', date: '1960-01-01' }, NOW, 1)
    facts.remember({ person: '爱人', relation: 'spouse', kind: 'preference', note: '不喜欢百合' }, NOW, 2)
    const [, list] = createFactTools(facts, { turnOf: () => 1, now: () => NOW })
    const execute = (
      list as { execute: (args: unknown, ctx: unknown) => Promise<{ facts: LifeFact[] }> }
    ).execute

    expect((await execute({}, ctx)).facts).toHaveLength(2)
    expect((await execute({ person: '爱人' }, ctx)).facts.map((fact) => fact.person)).toEqual(['爱人'])
    expect((await execute({ kind: 'birthday' }, ctx)).facts.map((fact) => fact.kind)).toEqual([
      'birthday',
    ])
  })

  it('fact_forget 成功路径：删除并回执 factId/deleted', async () => {
    const { store: facts } = store()
    const fact = facts.remember(
      { person: '爱人', relation: 'spouse', kind: 'preference', note: '不喜欢百合' },
      NOW,
      1,
    )
    const [, , forget] = createFactTools(facts, { turnOf: () => 1, now: () => NOW })
    const execute = (forget as { execute: (args: unknown, ctx: unknown) => Promise<unknown> }).execute

    await expect(execute({ factId: fact.factId }, ctx)).resolves.toEqual({
      factId: fact.factId,
      deleted: true,
    })
    expect(facts.list()).toHaveLength(0)
    expect(facts.versions()).toEqual({})
  })

  it('fact_remember 空 person / 缺 relation(kind) 在工具层就拒', async () => {
    const { store: facts } = store()
    const [remember] = createFactTools(facts, { turnOf: () => 1, now: () => NOW })
    const execute = (remember as { execute: (args: unknown, ctx: unknown) => Promise<unknown> })
      .execute

    await expect(
      execute({ person: '   ', relation: 'self', kind: 'preference' }, ctx),
    ).rejects.toMatchObject({ code: 'fact-invalid' })
    await expect(execute({ person: '我' }, ctx)).rejects.toMatchObject({ code: 'fact-invalid' })
    expect(facts.list()).toHaveLength(0)
  })
})
