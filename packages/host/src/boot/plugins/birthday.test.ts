/**
 * 生日主动检测（04 单）：事实库驱动 + 复用 `PROACTIVE_SERVICE`。
 *
 * 判据（任务书 §4.5 逐条）：
 * - 03-05 有一条"3 天后"，同一天再 tick 不重复；
 * - 03-08 当天仍 0 条（一年一次，key 带年份）；
 * - 脏事实静默跳过，不拖垮同批其它生日；
 * - `fact_forget` 之后不再提醒；
 * - 闰日与跨年按真实日历算。
 */

import { createContext } from '@bah/core'
import { classifyIntent, planFor } from '@bah/llm/demo'
import {
  SESSION_SERVICE,
  createFactStore,
  createFactTools,
  type FactStore,
  type SessionApi,
} from '@bah/runtime'
import { runTickJob, unregisterTickJob } from '@bah/saga'
import { asSessionId } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import type { BankAudit } from '@bah/bank'

import { BANK_AUDIT } from './bank-tools.ts'
import {
  BIRTHDAY_AHEAD_DAYS,
  birthdayCandidatesOf,
  occurrenceOf,
  parseBirthday,
} from './birthday.ts'
import { FACT_SERVICE } from './fact.ts'
import { DEFAULT_PROACTIVE, proactivePlugin } from './proactive.ts'

import { RUN_SERVICE } from '../boot.ts'
import { testRunContext } from '../test-run-context.ts'

/** 2026-03-05 09:00（UTC+8）。 */
const MAR_5 = Date.UTC(2026, 2, 5, 1, 0)
const MAR_8 = Date.UTC(2026, 2, 8, 1, 0)
const DAY = 86_400_000

afterEach(() => {
  unregisterTickJob('sub-reminder')
  unregisterTickJob('birthday-reminder')
})

function makeStore(): FactStore {
  let seq = 0
  return createFactStore({ nextId: () => `f-${String((seq += 1))}` })
}

interface Harness {
  readonly store: FactStore
  readonly events: { type: string; data: Readonly<Record<string, unknown>> }[]
  setNow(at: number): void
  tick(): Promise<void>
}

async function withPlugin(
  start: number,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  let now = start
  const events: { type: string; data: Readonly<Record<string, unknown>> }[] = []
  const store = makeStore()
  const ctx = createContext()
  ctx.provide(
    RUN_SERVICE,
    testRunContext({ sessionId: asSessionId('s-birthday'), now: () => now }),
  )
  ctx.provide(SESSION_SERVICE, { sessionId: 's-birthday' } as unknown as SessionApi)
  const audit: BankAudit = {
    append: (type, data) => {
      events.push({ type: String(type), data: data as Readonly<Record<string, unknown>> })
    },
  }
  ctx.provide(BANK_AUDIT, audit)
  ctx.provide(FACT_SERVICE, store)
  await ctx.use(proactivePlugin.plugin, { ...DEFAULT_PROACTIVE, catchUpOnBoot: false })
  await ctx.start()
  try {
    await run({
      store,
      events,
      setNow: (at) => {
        now = at
      },
      tick: async () => {
        runTickJob('birthday-reminder')
        await new Promise((resolve) => setImmediate(resolve))
      },
    })
  } finally {
    await ctx.dispose()
  }
}

function remember(store: FactStore, date: string, person = '爱人'): string {
  return store.remember(
    { person, relation: 'spouse', kind: 'birthday', date, confirmed: true },
    MAR_5,
    1,
  ).factId
}

describe('生日窗口（纯函数）', () => {
  it('提前 3 天命中；第 4 天不命中；当天仍命中（是否重复由幂等键决定）', () => {
    const fact = {
      factId: 'f-1',
      person: '爱人',
      relation: 'spouse',
      kind: 'birthday',
      date: '1990-03-08',
      confirmed: true,
      sourceTurn: 1,
      version: 1,
      updatedAt: MAR_5,
    } as const
    expect(birthdayCandidatesOf([fact], MAR_8 - 3 * DAY)).toHaveLength(1)
    expect(birthdayCandidatesOf([fact], MAR_8 - 4 * DAY)).toHaveLength(0)
    expect(birthdayCandidatesOf([fact], MAR_8)).toHaveLength(1)
    expect(BIRTHDAY_AHEAD_DAYS).toBe(3)
  })

  it('闰日：非闰年存储也接受；平年按 3 月 1 日算', () => {
    // 用户/模型可能把 2 月 29 日写成当前非闰年；月份与日是合法的就接受
    expect(parseBirthday('2026-02-29')).toEqual({ month: 2, day: 29 })
    expect(parseBirthday('2026-02-30')).toBeUndefined()

    // 2026 不是闰年
    expect(occurrenceOf(2, 29, Date.UTC(2026, 1, 26, 1, 0))).toMatchObject({
      year: 2026,
      month: 3,
      day: 1,
      daysUntil: 3,
    })
    // 2028 是闰年
    expect(occurrenceOf(2, 29, Date.UTC(2028, 1, 26, 1, 0))).toMatchObject({
      year: 2028,
      month: 2,
      day: 29,
      daysUntil: 3,
    })
  })

  it('跨年：12-30 提醒 1 月 2 日，键取明年的年份', () => {
    const fact = {
      factId: 'f-1',
      person: '爱人',
      relation: 'spouse',
      kind: 'birthday',
      date: '1990-01-02',
      confirmed: true,
      sourceTurn: 1,
      version: 1,
      updatedAt: MAR_5,
    } as const
    const at = Date.UTC(2026, 11, 30, 1, 0)
    const candidates = birthdayCandidatesOf([fact], at)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.key).toBe('birthday:f-1:2027')
    expect(candidates[0]?.title).toContain('3 天后')
  })
})

describe('生日提醒（插件 + 真实主动通道）', () => {
  it('03-05 tick → 1 条；同一天再 tick → 0 条；03-08 → 0 条（一年一次）', async () => {
    await withPlugin(MAR_5, async ({ store, events, setNow, tick }) => {
      const factId = remember(store, '1990-03-08')
      await tick()
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('proactive/reminder')
      expect(events[0]?.data).toMatchObject({
        source: 'birthday',
        key: `birthday:${factId}:2026`,
        channel: 'in-app',
      })
      expect(String(events[0]?.data['title'])).toContain('3 天后是爱人的生日（3 月 8 日）')
      expect(String(events[0]?.data['title'])).toContain('给爱人订生日计划')

      await tick()
      expect(events).toHaveLength(1)

      setNow(MAR_8)
      await tick()
      expect(events).toHaveLength(1)
    })
  })

  it('格式非法 / 缺日期 / 非生日种类：静默跳过，不拖垮同批合法事实', async () => {
    await withPlugin(MAR_5, async ({ store, events, tick }) => {
      remember(store, '2026-02-30', '母亲')
      store.remember(
        { person: '父亲', relation: 'parent', kind: 'birthday' },
        MAR_5,
        1,
      )
      store.remember(
        { person: '自己', relation: 'self', kind: 'anniversary', date: '2026-03-08' },
        MAR_5,
        1,
      )
      remember(store, '1990-03-08', '爱人')
      await tick()
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toMatchObject({ source: 'birthday' })
      expect(String(events[0]?.data['title'])).toContain('爱人')
    })
  })

  it('fact_forget 之后不再提醒', async () => {
    await withPlugin(MAR_5, async ({ store, events, tick }) => {
      const factId = remember(store, '1990-03-08')
      store.forget(factId)
      await tick()
      expect(events).toEqual([])
    })
  })
})

describe('04 §6 手工路径闭环：用户话术 → fact_remember → tick → 提醒', () => {
  it('「记住我爱人生日 3 月 8 日」经工具写入后，03-05 的 tick 真的发一条提醒', async () => {
    const intent = classifyIntent('记住我爱人生日 3 月 8 日')
    const call = planFor(intent)
      .flatMap((step) => step.content ?? [])
      .find((block) => block.kind === 'tool-call')
    if (call?.kind !== 'tool-call') throw new Error('路由没有产出 fact_remember 调用')
    expect(call).toMatchObject({ name: 'fact_remember' })

    await withPlugin(MAR_5, async ({ store, events, tick }) => {
      const tool = createFactTools(store, { turnOf: () => 1, now: () => MAR_5 }).find(
        (item) => item.name === 'fact_remember',
      )
      if (tool === undefined) throw new Error('事实库没有注册 fact_remember')
      await tool.execute(call.args, {
        sessionId: asSessionId('s-birthday'),
        callId: 'c-fact-remember',
        signal: new AbortController().signal,
      })

      expect(store.list({ kind: 'birthday' })).toHaveLength(1)
      expect(store.list({ kind: 'birthday' })[0]).toMatchObject({
        person: '爱人',
        relation: 'spouse',
        date: '2000-03-08',
      })

      await tick()
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('proactive/reminder')
      expect(events[0]?.data).toMatchObject({ source: 'birthday', channel: 'in-app' })
      expect(String(events[0]?.data['title'])).toContain('3 天后是爱人的生日（3 月 8 日）')
    })
  })
})
