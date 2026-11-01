/**
 * `proactive:reminder`：订阅续费主动提醒 + 通用主动通知通道（ADR-0016）。
 *
 * 判据集中在"提醒会不会被吞掉、会不会变噪音"：
 * - 到了窗口就必须真的落一条 `proactive/reminder`，`channel='in-app'`；
 * - 同一个 key 第二次问必须没有第二条事件（幂等靠 key，不靠运气）；
 * - 夜里被静默时**不落已发标记**：当天 `suppressedReason='quiet-hours'`，次日仍能发出去；
 * - 用户标了 `idle`（我不用了）的订阅一条都不许发；
 * - 7 天内多笔未标记 remind 的订阅合成**一条**汇总，不是每人一条。
 */

import { createContext } from '@bah/core'
import { SESSION_SERVICE, type SessionApi } from '@bah/runtime'
import { hasTickJob, runTickJob, unregisterTickJob } from '@bah/saga'
import { asSessionId, captureThrown } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import {
  BANK_IDENTITY,
  type BankAudit,
  type BankIdentityStore,
  type SubscriptionId,
  type UpcomingCharge,
} from '@bah/bank'

import type { Context, SessionId } from '@bah/core'

import { RUN_SERVICE } from '../boot.ts'
import { testRunContext } from '../test-run-context.ts'
import { BANK_AUDIT, BANK_SUBSCRIPTION_PROBE } from './bank-tools.ts'
import {
  DEFAULT_PROACTIVE,
  PROACTIVE_SERVICE,
  createProactiveService,
  proactivePlugin,
  reminderCandidatesOf,
  scanOnce,
  type ProactiveService,
  type ProactiveSettings,
} from './proactive.ts'

/** 2026-10-20 09:00（UTC+8）——白天，不会被静默。 */
const MORNING = Date.UTC(2026, 9, 20, 1, 0)
/** 同一天的 23:30（UTC+8）——落在 22:00–08:00 静默时段。 */
const LATE = Date.UTC(2026, 9, 20, 15, 30)
/** 次日 09:00（UTC+8）。 */
const NEXT_DAY = Date.UTC(2026, 9, 21, 1, 0)

const DAY = 86_400_000

afterEach(() => {
  // job 表是模块级单例：某个用例失败也不能把它留给下一个用例
  unregisterTickJob('sub-reminder')
})

/** 一条"即将扣款"的样本。 */
function charge(over: {
  readonly subscriptionId: string
  readonly dueAt: number
  readonly amountCents?: number
  readonly merchant?: string
  readonly reminderAheadDays?: number
}): UpcomingCharge {
  return {
    subscriptionId: over.subscriptionId as SubscriptionId,
    merchant: over.merchant ?? `商户 ${over.subscriptionId}`,
    amountCents: over.amountCents ?? 3_000,
    dueAt: over.dueAt,
    cycle: 'monthly',
    ...(over.reminderAheadDays === undefined ? {} : { reminderAheadDays: over.reminderAheadDays }),
  }
}

/** 让 `void scanOnce(...)` 的微任务链跑完。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface Harness {
  readonly ctx: Context
  readonly events: { readonly type: string; readonly data: Readonly<Record<string, unknown>> }[]
  setNow(at: number): void
  tick(): Promise<void>
}

interface Options {
  readonly charges: readonly UpcomingCharge[]
  readonly idle?: readonly string[]
  readonly start?: number
  /** 缺省 `null`：不开 boot 补跑（用例自己驱动 tick，避免与补跑抢同一个 key）。 */
  readonly catchUpOnBoot?: boolean
  /** `false` 时不提供 `bank:identity`（模拟未绑定会话）。 */
  readonly withIdentity?: boolean
}

/** 装一个最小的 ctx：只有本插件真正读的那几个服务。 */
async function withPlugin(options: Options, run: (harness: Harness) => Promise<void>): Promise<void> {
  let now = options.start ?? MORNING
  const events: { type: string; data: Readonly<Record<string, unknown>> }[] = []
  const ctx = createContext()
  ctx.provide(
    RUN_SERVICE,
    testRunContext({ sessionId: asSessionId('s-proactive'), now: () => now }),
  )
  // 插件只读 `sessionId`，给一个最小替身即可（不启动真会话，测试更快也更准）
  ctx.provide(SESSION_SERVICE, { sessionId: 's-proactive' } as unknown as SessionApi)
  const audit: BankAudit = {
    append: (type, data) => {
      events.push({ type: String(type), data: data as Readonly<Record<string, unknown>> })
    },
  }
  ctx.provide(BANK_AUDIT, audit)
  if (options.withIdentity !== false) {
    // 只要 `resolve` 一个方法：提醒的口径是"从会话解析出用户"，其余方法与本设计无关
    ctx.provide(BANK_IDENTITY, {
      resolve: (sessionId: SessionId) => (String(sessionId) === 's-proactive' ? 'u-1' : undefined),
    } as unknown as BankIdentityStore)
  }
  ctx.provide(BANK_SUBSCRIPTION_PROBE, {
    upcoming: () => Promise.resolve([...options.charges]),
    idleIds: () => Promise.resolve([...(options.idle ?? [])]),
  })
  const settings: ProactiveSettings = {
    ...DEFAULT_PROACTIVE,
    catchUpOnBoot: options.catchUpOnBoot ?? false,
  }
  await ctx.use(proactivePlugin.plugin, settings)
  await ctx.start()
  try {
    await run({
      ctx,
      events,
      setNow: (at) => {
        now = at
      },
      tick: async () => {
        runTickJob('sub-reminder')
        await flush()
      },
    })
  } finally {
    await ctx.dispose()
  }
}

describe('proactive:reminder 配置面', () => {
  it('缺省开启且启动即补跑；未知键 fail-loud、非布尔值拒绝', () => {
    expect(proactivePlugin.validate({})).toEqual(DEFAULT_PROACTIVE)
    expect(captureThrown(() => proactivePlugin.validate({ aheadDays: 3 })).code).toBe(
      'unknown-config-key',
    )
    expect(captureThrown(() => proactivePlugin.validate({ enabled: 'yes' })).code).toBe(
      'invalid-config',
    )
  })

  it('enabled=false：不注册 tick job、不提供服务', async () => {
    const ctx = createContext()
    ctx.provide(
      RUN_SERVICE,
      testRunContext({ sessionId: asSessionId('s-proactive-off'), now: () => MORNING }),
    )
    ctx.provide(SESSION_SERVICE, { sessionId: 's-proactive-off' } as unknown as SessionApi)
    await ctx.use(proactivePlugin.plugin, { ...DEFAULT_PROACTIVE, enabled: false })
    await ctx.start()
    try {
      expect(hasTickJob('sub-reminder')).toBe(false)
      expect(captureThrown(() => ctx.get(PROACTIVE_SERVICE)).code).toBeDefined()
    } finally {
      await ctx.dispose()
    }
  })
})

describe('提醒规则（任务书 §2 的五条）', () => {
  it('标了 remind 的订阅进入窗口 → 1 条提醒，channel=in-app', async () => {
    await withPlugin(
      {
        charges: [
          charge({
            subscriptionId: 's-1',
            merchant: '视频会员',
            amountCents: 2_500,
            dueAt: MORNING + 3 * DAY,
            reminderAheadDays: 3,
          }),
        ],
      },
      async ({ events, tick }) => {
        await tick()
        expect(events).toEqual([
          {
            type: 'proactive/reminder',
            data: {
              source: 'subscription',
              key: 'sub:s-1:2026-10',
              title: '视频会员 3 天后扣费 ¥25.00',
              channel: 'in-app',
              at: MORNING,
            },
          },
        ])
      },
    )
  })

  it('同一天再 tick：0 条新事件（幂等靠 key）', async () => {
    await withPlugin(
      {
        charges: [charge({ subscriptionId: 's-1', dueAt: MORNING + 2 * DAY, reminderAheadDays: 3 })],
      },
      async ({ events, tick }) => {
        await tick()
        expect(events).toHaveLength(1)
        await tick()
        expect(events).toHaveLength(1)
      },
    )
  })

  it('23:30 被静默：当天只有 suppressedReason=quiet-hours，次日照常发', async () => {
    await withPlugin(
      {
        start: LATE,
        charges: [charge({ subscriptionId: 's-1', dueAt: LATE + 2 * DAY, reminderAheadDays: 3 })],
      },
      async ({ events, setNow, tick }) => {
        await tick()
        expect(events).toHaveLength(1)
        expect(events[0]?.data).toMatchObject({
          key: 'sub:s-1:2026-10',
          channel: 'none',
          suppressedReason: 'quiet-hours',
          at: LATE,
        })

        // 静默不落"已发"标记：同一天再 tick 不该再记一条审计（防每个 tick 一条噪音）
        await tick()
        expect(events).toHaveLength(1)

        // 次日 09:00 再扫：同一个 key 必须还能发出去（没被夜里那次吞掉）
        setNow(NEXT_DAY)
        await tick()
        expect(events).toHaveLength(2)
        expect(events[1]?.data).toMatchObject({ channel: 'in-app', at: NEXT_DAY })
      },
    )
  })

  it('跨月 tick 同一笔扣款：幂等键取 dueAt 月份，不会提醒两次（复审 P1-4）', async () => {
    const oct30 = Date.UTC(2026, 9, 30, 1, 0)
    const nov1 = Date.UTC(2026, 10, 1, 1, 0)
    await withPlugin(
      {
        start: oct30,
        charges: [charge({ subscriptionId: 's-cross', dueAt: nov1, reminderAheadDays: 5 })],
      },
      async ({ events, setNow, tick }) => {
        await tick()
        expect(events).toHaveLength(1)
        expect(events[0]?.data['key']).toBe('sub:s-cross:2026-11')

        // 跨月后再 tick：同一个 key（dueAt 月份），不产生第二条
        setNow(nov1)
        await tick()
        expect(events).toHaveLength(1)
      },
    )
  })

  it('标了 idle（我不用了）的订阅：两条路径都不提醒', async () => {
    await withPlugin(
      {
        idle: ['s-idle'],
        charges: [
          charge({ subscriptionId: 's-idle', dueAt: MORNING + 2 * DAY, reminderAheadDays: 3 }),
          charge({ subscriptionId: 's-alive', dueAt: MORNING + 4 * DAY }),
        ],
      },
      async ({ events, tick }) => {
        await tick()
        // 只剩那一笔非 idle 的汇总；idle 的那笔既不单独提醒，也不进汇总
        expect(events).toHaveLength(1)
        expect(events[0]?.data['key']).toBe('sub:digest:2026-10-20')
        expect(String(events[0]?.data['title'])).not.toContain('s-idle')
      },
    )
  })

  it('7 天内 3 笔未标 remind → 只发 1 条汇总（不是 3 条），列前 3 条', async () => {
    await withPlugin(
      {
        charges: [
          charge({ subscriptionId: 's-1', merchant: '视频会员', dueAt: MORNING + 2 * DAY }),
          charge({ subscriptionId: 's-2', merchant: '音乐会员', dueAt: MORNING + 4 * DAY }),
          charge({ subscriptionId: 's-3', merchant: '云盘', dueAt: MORNING + 6 * DAY }),
        ],
      },
      async ({ events, tick }) => {
        await tick()
        expect(events).toHaveLength(1)
        expect(events[0]?.data).toMatchObject({
          source: 'subscription',
          key: 'sub:digest:2026-10-20',
          channel: 'in-app',
        })
        const title = String(events[0]?.data['title'])
        expect(title).toContain('3 笔自动续费')
        expect(title).toContain('视频会员')
        expect(title).toContain('音乐会员')
        expect(title).toContain('云盘')
      },
    )
  })
})

describe('通道本身（PROACTIVE_SERVICE，04 单照抄的那一份）', () => {
  it('未绑定身份时不产出任何事件（无身份 = 不提醒，不是报错）', async () => {
    await withPlugin(
      {
        withIdentity: false,
        charges: [charge({ subscriptionId: 's-1', dueAt: MORNING + 2 * DAY })],
      },
      async ({ events, tick }) => {
        await tick()
        expect(events).toEqual([])
      },
    )
  })

  it('没有 bank:audit 时 push 判 not-ready：宁可说"没发"，也不发一条不落账的提醒', async () => {
    const service = createProactiveService({ audit: () => undefined, now: () => MORNING })
    const delivery = await service.push({
      source: 'subscription',
      key: 'sub:x:2026-10',
      priority: 'decision',
      at: MORNING,
      title: 'x',
    })
    expect(delivery).toEqual({ sent: false, channel: 'none', reason: 'not-ready' })
  })

  it('预算不可绕过：日上限（6 条）之后只落 suppressedReason=daily-cap', async () => {
    const events: Readonly<Record<string, unknown>>[] = []
    const service = createProactiveService({
      audit: () => ({
        append: (_type, data) => {
          events.push(data as Readonly<Record<string, unknown>>)
        },
      }),
      now: () => MORNING,
    })
    for (let index = 0; index < 8; index += 1) {
      await service.push({
        source: 'subscription',
        key: `sub:k${String(index)}:2026-10`,
        // alert 不受静默与日上限约束 ⇒ 用 decision 才能测到 daily-cap
        priority: 'decision',
        at: MORNING + index,
        title: `第 ${String(index)} 条`,
      })
    }
    const sent = events.filter((item) => item['channel'] === 'in-app')
    const capped = events.filter((item) => item['suppressedReason'] === 'daily-cap')
    expect(sent).toHaveLength(6)
    expect(capped.length).toBeGreaterThan(0)
  })
})

describe('候选生成是纯函数（不读时钟/随机）', () => {
  it('同样的入参两次输出全等；已过期的到期日不提醒', () => {
    const charges: readonly UpcomingCharge[] = [
      charge({ subscriptionId: 's-1', dueAt: MORNING + 2 * DAY, reminderAheadDays: 3 }),
      charge({ subscriptionId: 's-2', dueAt: MORNING - 2 * DAY }),
    ]
    const first = reminderCandidatesOf(charges, new Set(), MORNING)
    expect(first).toEqual(reminderCandidatesOf(charges, new Set(), MORNING))
    expect(first.map((item) => item.key)).toEqual(['sub:s-1:2026-10'])
  })

  it('scanOnce 在未绑定时短路，不碰 probe（少一次无意义 IO）', async () => {
    let called = 0
    const delivered = await scanOnce({
      now: () => MORNING,
      userId: () => undefined,
      probe: {
        upcoming: () => {
          called += 1
          return Promise.resolve([])
        },
        idleIds: () => {
          called += 1
          return Promise.resolve([])
        },
      },
      push: () => Promise.resolve({ sent: true, channel: 'in-app', reason: 'ok' }),
    })
    expect(delivered).toEqual([])
    expect(called).toBe(0)
  })
})

describe('tick job 生命周期', () => {
  it('注册即可逆：dispose 后 job 消失', async () => {
    const ctx = createContext()
    ctx.provide(
      RUN_SERVICE,
      testRunContext({ sessionId: asSessionId('s-proactive-life'), now: () => MORNING }),
    )
    ctx.provide(SESSION_SERVICE, { sessionId: 's-proactive-life' } as unknown as SessionApi)
    await ctx.use(proactivePlugin.plugin, { ...DEFAULT_PROACTIVE, catchUpOnBoot: false })
    await ctx.start()
    expect(hasTickJob('sub-reminder')).toBe(true)
    await ctx.dispose()
    expect(hasTickJob('sub-reminder')).toBe(false)
  })

  it('服务键可由消费方取出（04 单靠它，不 import 插件实现）', async () => {
    const ctx = createContext()
    ctx.provide(
      RUN_SERVICE,
      testRunContext({ sessionId: asSessionId('s-proactive-svc'), now: () => MORNING }),
    )
    ctx.provide(SESSION_SERVICE, { sessionId: 's-proactive-svc' } as unknown as SessionApi)
    await ctx.use(proactivePlugin.plugin, { ...DEFAULT_PROACTIVE, catchUpOnBoot: false })
    await ctx.start()
    try {
      const service: ProactiveService = ctx.get(PROACTIVE_SERVICE)
      expect(typeof service.push).toBe('function')
    } finally {
      await ctx.dispose()
    }
  })
})
