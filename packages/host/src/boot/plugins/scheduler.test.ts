/**
 * `plan:scheduler`：到期唤醒的宿主驱动器。
 *
 * 判据集中在**"承诺会不会静默失效"**：
 * - boot 补跑必须真的调一次 `wake(source:'boot')`——这是 durable 承诺第一次成立的地方；
 * - tick 只有一个时钟源（`saga/tick`），且没有 plan 插件时不能被它带崩；
 * - 唤醒失败只进日志（refused / failed），不阻断后续；
 * - 等到 plan 服务就绪最多重试 20 次，然后如实告警；
 * - dispose 后 tick job 注销、计时器清掉（不然进程退出前还会唤醒一次）。
 */

import { createContext } from '@bah/core'
import { hasTickJob, runTickJob, unregisterTickJob } from '@bah/saga'
import { asSessionId, captureThrown } from '@bah/test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Context } from '@bah/core'

import { RUN_SERVICE } from '../boot.ts'
import { testRunContext } from '../test-run-context.ts'
import { DEFAULT_SCHEDULER, schedulerPlugin, type SchedulerSettings } from './scheduler.ts'
import {
  PLAN_WAKE_SERVICE,
  type PlanWakeEntry,
  type PlanWakeReport,
  type PlanWakeRunner,
} from './plan.ts'

/**
 * 日志探针：Vitest 会拦截 `console.error`，spy `process.stderr.write` 拿不到 `logJson` 的行。
 * mock 只替换 `logJson`，其余 `@bah/util` 导出保留原实现。
 */
const { logJson } = vi.hoisted(() => ({ logJson: vi.fn() }))
vi.mock('@bah/util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bah/util')>()),
  logJson,
}))

const NOW = 1_700_000_000_000

/** 一份合法的最小唤醒报告（entries 由用例覆写）。 */
function report(overrides: Partial<PlanWakeReport> = {}): PlanWakeReport {
  return { at: NOW, now: NOW, source: 'boot', ok: true, entries: [], notified: [], ...overrides }
}

function entry(status: PlanWakeEntry['status']): PlanWakeEntry {
  return { planId: 'p-1', windowId: 'w-1', occurrence: '2026-10-31', key: 'k-1', status }
}

/** 只取本插件打的行，不受 runner 之外的模块日志干扰。 */
function planLogs(): readonly (readonly unknown[])[] {
  return logJson.mock.calls.filter((call) => String(call[1]).startsWith('host.plan-'))
}

/** 跨用例兜底：即使某个用例断言失败，也别把 plan-wake job 留给下一个用例。 */
afterEach(() => {
  unregisterTickJob('plan-wake')
  logJson.mockClear()
})

interface Harness {
  readonly ctx: Context
  readonly runner: { readonly wake: ReturnType<typeof vi.fn> }
}

interface Options {
  readonly settings?: Readonly<Record<string, unknown>>
  /** `false` 时不提供 `bah:plan-wake`（模拟 plan 插件缺席）。 */
  readonly withPlan?: boolean
  readonly wake?: () => Promise<PlanWakeReport>
}

async function withScheduler(
  options: Options,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const ctx = createContext()
  ctx.provide(
    RUN_SERVICE,
    testRunContext({ sessionId: asSessionId('s-scheduler'), now: () => NOW }),
  )
  const wake = vi.fn(options.wake ?? (() => Promise.resolve(report())))
  if (options.withPlan !== false) {
    ctx.provide(PLAN_WAKE_SERVICE, { wake } as PlanWakeRunner)
  }
  await ctx.use(
    schedulerPlugin.plugin,
    schedulerPlugin.validate(options.settings ?? {}) as SchedulerSettings,
  )
  await ctx.start()
  try {
    await run({ ctx, runner: { wake } })
  } finally {
    await ctx.dispose()
  }
}

/** 让 `queueMicrotask` + `.then/.catch` 都跑完（真实定时器下用 setImmediate 更稳）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('plan:scheduler 配置面', () => {
  it('缺省值：开启 tick 且启动即补跑', () => {
    expect(schedulerPlugin.validate({})).toEqual(DEFAULT_SCHEDULER)
    expect(DEFAULT_SCHEDULER).toEqual({ enabled: true, catchUpOnBoot: true })
  })

  it('未知键 fail-loud，非布尔值拒绝', () => {
    const unknown = captureThrown(() => schedulerPlugin.validate({ interval: 5 }))
    expect(unknown.code).toBe('unknown-config-key')
    const invalid = captureThrown(() => schedulerPlugin.validate({ enabled: 'yes' }))
    expect(invalid.code).toBe('invalid-config')
  })
})

describe('boot 补跑与 tick 驱动', () => {
  it('启动后补跑一次，来源是 boot，时钟取 RUN_SERVICE.now()', async () => {
    await withScheduler({}, async ({ runner }) => {
      await flush()
      expect(runner.wake).toHaveBeenCalledTimes(1)
      expect(runner.wake).toHaveBeenCalledWith({ at: NOW, source: 'boot' })
    })
  })

  it('saga/tick 的 plan-wake job 触发时来源是 tick', async () => {
    await withScheduler({}, async ({ runner }) => {
      await flush()
      runner.wake.mockClear()
      expect(hasTickJob('plan-wake')).toBe(true)
      runTickJob('plan-wake')
      await flush()
      expect(runner.wake).toHaveBeenCalledTimes(1)
      expect(runner.wake).toHaveBeenCalledWith({ at: NOW, source: 'tick' })
    })
  })

  it('catchUpOnBoot=false：只保留 tick 驱动', async () => {
    await withScheduler({ settings: { catchUpOnBoot: false } }, async ({ runner }) => {
      await flush()
      expect(runner.wake).not.toHaveBeenCalled()
      runTickJob('plan-wake')
      await flush()
      expect(runner.wake).toHaveBeenCalledWith({ at: NOW, source: 'tick' })
    })
  })

  it('enabled=false：既不注册 tick job 也不补跑', async () => {
    await withScheduler({ settings: { enabled: false } }, async ({ runner }) => {
      await flush()
      expect(hasTickJob('plan-wake')).toBe(false)
      runTickJob('plan-wake')
      await flush()
      expect(runner.wake).not.toHaveBeenCalled()
    })
  })

  it('没有 plan 插件时 tick 静默跳过（不把 janitor/recon 带崩）', async () => {
    await withScheduler({ settings: { catchUpOnBoot: false }, withPlan: false }, () => {
      expect(() => runTickJob('plan-wake')).not.toThrow()
      return Promise.resolve()
    })
  })
})

describe('唤醒失败只进日志，不阻断', () => {
  it('report.ok=false → host.plan-wake-refused 带 code', async () => {
    await withScheduler(
      { wake: () => Promise.resolve(report({ ok: false, code: 'window-clock-ahead' })) },
      async () => {
        await flush()
        expect(planLogs()).toContainEqual([
          'warn',
          'host.plan-wake-refused',
          { source: 'boot', code: 'window-clock-ahead' },
        ])
      },
    )
  })

  it('有 executed 条目时记一条 host.plan-wake（含 total）', async () => {
    await withScheduler(
      {
        wake: () =>
          Promise.resolve(report({ entries: [entry('executed'), entry('skipped'), entry('failed')] })),
      },
      async () => {
        await flush()
        expect(planLogs()).toContainEqual([
          'info',
          'host.plan-wake',
          { source: 'boot', executed: 1, total: 3 },
        ])
      },
    )
  })

  it('report.ok=false 且无 code → 记 unknown（不丢这一行）', async () => {
    await withScheduler({ wake: () => Promise.resolve(report({ ok: false })) }, async () => {
      await flush()
      expect(planLogs()).toContainEqual([
        'warn',
        'host.plan-wake-refused',
        { source: 'boot', code: 'unknown' },
      ])
    })
  })

  it('wake 抛错 → host.plan-wake-failed 带原因，进程不崩', async () => {
    await withScheduler({ wake: () => Promise.reject(new Error('db-locked')) }, async () => {
      await flush()
      expect(planLogs()).toContainEqual([
        'error',
        'host.plan-wake-failed',
        { source: 'boot', reason: 'db-locked' },
      ])
    })
  })

  it('wake 抛非 Error → reason 用 String() 归一化', async () => {
    await withScheduler({ wake: () => Promise.reject('plain-text') }, async () => {
      await flush()
      expect(planLogs()).toContainEqual([
        'error',
        'host.plan-wake-failed',
        { source: 'boot', reason: 'plain-text' },
      ])
    })
  })

  it('没有 executed 条目且 ok 时不打点（避免每次 tick 刷日志）', async () => {
    await withScheduler(
      { wake: () => Promise.resolve(report({ entries: [entry('skipped')] })) },
      async () => {
        await flush()
        expect(planLogs()).toEqual([])
      },
    )
  })
})

describe('等待 plan 服务就绪', () => {
  it('服务始终缺席：重试 20 次后告警，且不再继续', async () => {
    vi.useFakeTimers()
    try {
      await withScheduler({ withPlan: false }, async () => {
        // queueMicrotask → catchUp(0) 失败 → 每 50ms 重试
        await Promise.resolve()
        for (let attempt = 0; attempt < 21; attempt += 1) {
          vi.advanceTimersByTime(50)
          await Promise.resolve()
        }
        expect(planLogs()).toContainEqual([
          'warn',
          'host.plan-catchup-unavailable',
          { attempts: 20 },
        ])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 清掉重试计时器：之后不再补跑、也不再告警', async () => {
    vi.useFakeTimers()
    try {
      const ctx = createContext()
      ctx.provide(
        RUN_SERVICE,
        testRunContext({ sessionId: asSessionId('s-scheduler-dispose'), now: () => NOW }),
      )
      await ctx.use(schedulerPlugin.plugin, schedulerPlugin.validate({}))
      await ctx.start()
      await Promise.resolve()
      await ctx.dispose()
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
      expect(planLogs()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 注销 tick job', async () => {
    const ctx = createContext()
    ctx.provide(
      RUN_SERVICE,
      testRunContext({ sessionId: asSessionId('s-scheduler-rollback'), now: () => NOW }),
    )
    await ctx.use(schedulerPlugin.plugin, schedulerPlugin.validate({ catchUpOnBoot: false }))
    await ctx.start()
    expect(hasTickJob('plan-wake')).toBe(true)
    await ctx.dispose()
    expect(hasTickJob('plan-wake')).toBe(false)
  })
})
