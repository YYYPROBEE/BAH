/**
 * 运行时上下文解析器（`packages/host/src/boot/runtime-context.ts`）。
 *
 * 这一层是**策略**：静态画像与 bank 槽位怎么合并、什么情况降级、什么情况让 turn 失败。
 * 它不读核心、不做金额格式化，所以可以完全用 stub 端口测（不起 boot）。
 *
 * 12 条主用例对应 03 §5 的矩阵；另加 4 条守门用例（懒取次数 / 降级日志 / 姓名不泄漏 /
 * 静态姓名不被顶用）。
 */

import { describe, expect, it, vi } from 'vitest'

import { asSessionId, captureRejection } from '@bah/test-support'
import type {
  RuntimeContextInvocation,
  RuntimeContextResolution,
  RuntimeContextSource,
  RuntimeContextView,
} from '@bah/runtime'

import { createRuntimeContextResolver, type RuntimeContextResolver } from './runtime-context.ts'

const T0 = 1_700_000_000_000
const SESSION = asSessionId('s-ctx')
const PARENT = asSessionId('s-parent')

/** 静态画像（web profile 的同形状）。 */
const STATIC: RuntimeContextView = {
  user: { name: '张三', level: '金卡' },
  notes: ['本对话运行在仿真数据集（demo 档），账户与金额均为造数，不产生真实资金变动。'],
}

/** 一次 bank/ok 的解析结果（正常数据）。 */
const OK: RuntimeContextResolution = {
  status: 'ok',
  asOfText: '2023-11-15 06:13',
  view: {
    user: { name: '张三' },
    accounts: [
      {
        name: '活期',
        maskedNumber: '1234',
        balanceText: '¥12,345.67',
        availableText: '¥12,345.67',
        statusText: '正常',
      },
    ],
    recentTransactions: ['2023-11-10 06:13 转出 ¥68.00（消费）'],
    notes: ['近 30 天没有交易记录'],
  },
}

/** 一次解析的入参。 */
function invocation(patch: Partial<RuntimeContextInvocation> = {}): RuntimeContextInvocation {
  return {
    sessionId: SESSION,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    now: () => T0,
    ...patch,
  }
}

/** stub 端口（记录每次调用，便于断言"每 step 现取"）。 */
interface StubSource extends RuntimeContextSource {
  readonly calls: readonly RuntimeContextInvocation[]
}

function stubSource(resolution: RuntimeContextResolution): StubSource {
  const calls: RuntimeContextInvocation[] = []
  return {
    calls,
    resolve: async (inv) => {
      calls.push(inv)
      return resolution
    },
  }
}

/** 建解析器（`source` 缺省 = 没有端口）。 */
function resolverOf(options: {
  readonly staticView?: RuntimeContextView
  readonly source?: RuntimeContextSource
  readonly getSource?: () => RuntimeContextSource | undefined
}): RuntimeContextResolver {
  return createRuntimeContextResolver({
    ...(options.staticView === undefined ? {} : { staticView: options.staticView }),
    slots: { source: 'bank' },
    getSource: options.getSource ?? (() => options.source),
  })
}

/* ── 1. 开关关着：逐字保持 ─────────────────────────────────────────────────── */

describe('slots.source=none', () => {
  it('返回同一个静态视图对象（不 copy），且不写 meta', async () => {
    const source = stubSource(OK)
    const resolver = createRuntimeContextResolver({
      staticView: STATIC,
      slots: { source: 'none' },
      getSource: () => source,
    })
    const view = await resolver(invocation())
    expect(view).toBe(STATIC)
    expect(view?.meta).toBeUndefined()
    // 开关关着时连端口都不该碰（更不该取钟）
    expect(source.calls).toHaveLength(0)
  })

  it('没有静态画像 → undefined（不装配 runtime.context 段）', async () => {
    const resolver = createRuntimeContextResolver({
      slots: { source: 'none' },
      getSource: () => stubSource(OK),
    })
    await expect(resolver(invocation())).resolves.toBeUndefined()
  })
})

/* ── 2. bank/ok：合并语义 ─────────────────────────────────────────────────── */

describe('slots.source=bank · ok', () => {
  it('姓名取权威、等级取静态、账户/流水透传、notes 顺序（provider 前、静态后）、meta.ok', async () => {
    const resolver = resolverOf({ staticView: STATIC, source: stubSource(OK) })
    const view = await resolver(invocation())
    expect(view).toEqual({
      user: { name: '张三', level: '金卡' },
      accounts: OK.view?.accounts,
      recentTransactions: OK.view?.recentTransactions,
      notes: ['近 30 天没有交易记录', ...(STATIC.notes ?? [])],
      meta: { source: 'bank', status: 'ok', asOfText: '2023-11-15 06:13' },
    })
  })

  it('provider 没给姓名时只保留静态 level（不显示未验证姓名）', async () => {
    const resolver = resolverOf({
      staticView: STATIC,
      source: stubSource({
        status: 'ok',
        view: { accounts: OK.view?.accounts ?? [], notes: ['没有可展示的账户'] },
      }),
    })
    const view = await resolver(invocation())
    expect(view?.user).toEqual({ level: '金卡' })
    expect(view?.meta).toEqual({ source: 'bank', status: 'ok' })
  })

  it('不返回时丢说明：provider 无 notes 且静态无 notes → 没有 notes 键', async () => {
    const resolver = resolverOf({
      staticView: { user: { level: '金卡' } },
      source: stubSource({
        status: 'ok',
        asOfText: '2023-11-15 06:13',
        view: { user: { name: '张三' }, accounts: OK.view?.accounts ?? [] },
      }),
    })
    const view = await resolver(invocation())
    expect(view).not.toHaveProperty('notes')
  })
})

/* ── 3. unbound / degraded：不显示未验证画像 ──────────────────────────────── */

describe('slots.source=bank · 非 ok', () => {
  it('unbound → 无 user/accounts，只有静态 notes + meta.unbound', async () => {
    const resolver = resolverOf({ staticView: STATIC, source: stubSource({ status: 'unbound' }) })
    const view = await resolver(invocation())
    expect(view).toEqual({
      notes: STATIC.notes,
      meta: { source: 'bank', status: 'unbound' },
    })
    // 静态姓名在未绑定态**不得**出现（未验证的姓名 = 主体错位风险）
    expect(view?.user).toBeUndefined()
  })

  it('degraded → 无 user/accounts，meta 带 code，并记一条结构化 warn', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const resolver = resolverOf({
        staticView: STATIC,
        source: stubSource({ status: 'degraded', code: 'slots-timeout' }),
      })
      const view = await resolver(invocation())
      expect(view).toEqual({
        notes: STATIC.notes,
        meta: { source: 'bank', status: 'degraded', code: 'slots-timeout' },
      })
      const logged = errors.mock.calls.map((call) => String(call[0])).join('\n')
      expect(logged).toContain('"code":"context/slots-degraded"')
      expect(logged).toContain('"reason":"slots-timeout"')
      // 日志字段只有 code/source：不含姓名、尾号、错误原文
      expect(logged).not.toContain('张三')
      expect(logged).not.toContain('1234')
    } finally {
      errors.mockRestore()
    }
  })

  it('degraded 的 slots-aborted / slots-circuit-open 不重复记 warn（各有人负责）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      for (const code of ['slots-aborted', 'slots-circuit-open']) {
        const resolver = resolverOf({ source: stubSource({ status: 'degraded', code }) })
        await resolver(invocation())
      }
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})

/* ── 4. 失败面：这是策略，不是适配器 ──────────────────────────────────────── */

describe('slots.source=bank · fail-loud', () => {
  it('姓名冲突 → slots-user-mismatch，message 不带姓名', async () => {
    const error = await captureRejection(() =>
      resolverOf({
        staticView: { user: { name: '李四', level: '金卡' }, notes: ['disclaimer'] },
        source: stubSource(OK),
      })(invocation()),
    )
    expect(error.code).toBe('slots-user-mismatch')
    const message = String((error as { message?: string }).message ?? '')
    expect(message).not.toContain('李四')
    expect(message).not.toContain('张三')
  })

  it('缺端口 → slots-source-missing（配置说通电、装配却没给 = 装配错误）', async () => {
    const error = await captureRejection(() =>
      resolverOf({ staticView: STATIC, getSource: () => undefined })(invocation()),
    )
    expect(error.code).toBe('slots-source-missing')
  })

  it('static 写了 accounts 又开 bank → invalid-config（两个真相源）', async () => {
    const error = await captureRejection(() =>
      resolverOf({
        staticView: { accounts: OK.view?.accounts ?? [] },
        source: stubSource(OK),
      })(invocation()),
    )
    expect(error.code).toBe('invalid-config')
  })

  it('返回 ok 却没有 view → slots-empty-resolution', async () => {
    const error = await captureRejection(() =>
      resolverOf({ source: stubSource({ status: 'ok' }) })(invocation()),
    )
    expect(error.code).toBe('slots-empty-resolution')
  })

  it('返回 ok 但四块全空 → slots-empty-resolution（否则渲染两行噪音）', async () => {
    const error = await captureRejection(() =>
      resolverOf({ source: stubSource({ status: 'ok', view: {} }) })(invocation()),
    )
    expect(error.code).toBe('slots-empty-resolution')
  })
})

/* ── 5. 取消与调用契约 ────────────────────────────────────────────────────── */

describe('调用契约', () => {
  it('解析返回后 signal 已 abort → undefined（agent 会判 cancelled）', async () => {
    const controller = new AbortController()
    const source: RuntimeContextSource = {
      resolve: async () => {
        controller.abort()
        return OK
      },
    }
    const resolver = resolverOf({ staticView: STATIC, source })
    await expect(resolver(invocation({ signal: controller.signal }))).resolves.toBeUndefined()
  })

  it('sessionId 透传：fork 场景收到的是**子会话**与父会话', async () => {
    const source = stubSource(OK)
    const resolver = resolverOf({ staticView: STATIC, source })
    await resolver(invocation({ sessionId: asSessionId('s-child'), forkOf: PARENT }))
    expect(source.calls[0]?.sessionId).toBe('s-child')
    expect(source.calls[0]?.forkOf).toBe('s-parent')
  })

  it('每 step 现取端口（两次解析 → 两次 getSource + 两次 resolve）', async () => {
    const source = stubSource(OK)
    const getSource = vi.fn(() => source)
    const resolver = resolverOf({ staticView: STATIC, getSource })
    await resolver(invocation({ step: 1 }))
    await resolver(invocation({ step: 2 }))
    expect(getSource).toHaveBeenCalledTimes(2)
    expect(source.calls).toHaveLength(2)
    expect(source.calls.map((call) => call.step)).toEqual([1, 2])
  })
})
