/**
 * 内核测试上下文（施工单 12 §3 的 `mock-ctx` 模块；测试地基）。
 *
 * 目标：写用例时不再手搓「建 Context → 装插件 → 起停 → 收拾残留」，
 * 也不再用真实时间做等待（确定性纪律见 `docs/testing.md`）。
 *
 * 纪律：本模块只做**测试脚手架**，不得包含任何业务语义；
 * 断言一律通过内核公开 API 观察（施工单 02 §2 要点）。
 */

import type { Context, EventMode, Listener, PluginV2 } from '@bah/core'
import { createContext } from '@bah/core'
import { BahError } from '@bah/util'

/** 事件录制器：按派发顺序累积载荷，供断言「发了几次、最后一条是什么」。 */
export interface Recorder<T = unknown> {
  /** 已录载荷（只读视图，仍在累积）。 */
  readonly values: readonly T[]
  /** 已录条数。 */
  readonly count: number
  /** 最后一条（没有则 `undefined`）。 */
  last(): T | undefined
  /** 清空已录载荷（保留登记，继续录）。 */
  clear(): void
}

/** 测试上下文：一个内核应用 + 事件录制 + 起停收尾。 */
export interface TestContext {
  /** 被测的内核应用。 */
  readonly ctx: Context
  /** 注册插件（等价 `ctx.use`，但返回测试上下文便于链式）。 */
  use<P>(plugin: PluginV2<P>, config?: P): Promise<TestContext>
  /** 推进到 `ready`。 */
  start(): Promise<TestContext>
  /** 关闭并回滚全部贡献（幂等）。 */
  dispose(reason?: string): Promise<void>
  /** 录制某事件：返回的 Recorder 在每次派发时追加一条载荷。 */
  record<T = unknown>(name: string, mode: EventMode): Recorder<T>
}

/** 建一个测试上下文（用完请 `dispose`，或用 `withTestContext` 自动收尾）。 */
export function createTestContext(): TestContext {
  const ctx = createContext()

  const test: TestContext = {
    ctx,

    async use(plugin, config) {
      await ctx.use(plugin, config)
      return test
    },

    async start() {
      await ctx.start()
      return test
    },

    dispose(reason) {
      return ctx.dispose(reason)
    },

    record<T>(name: string, mode: EventMode): Recorder<T> {
      const values: T[] = []
      // 监听器一律**模式无关**登记（不带 mode），原因：waterfall 的监听器必须拿到 next 交还，
      // 而带 mode 的低层重载只接受一参形状。这里按 mode 决定「怎么不干扰派发」：
      // waterfall 交还控制权；其余模式返回 undefined（等于不参与裁决）。
      const listener: Listener<string> =
        mode === 'waterfall'
          ? (payload, next) => {
              values.push(payload as T)
              return next(payload)
            }
          : (payload) => {
              values.push(payload as T)
            }
      ctx.events.on(name, listener)

      return {
        values,
        get count() {
          return values.length
        },
        last: () => values[values.length - 1],
        clear: () => {
          values.length = 0
        },
      }
    },
  }

  return test
}

/**
 * 跑一段用例并在结束（包含抛错）后自动 `dispose`。
 *
 * @param run 用例体，拿到测试上下文
 * @param reason 透传给每个 disposer 的关闭原因（审计用）
 */
export async function withTestContext(
  run: (test: TestContext) => Promise<void> | void,
  reason = 'test-finished',
): Promise<void> {
  const test = createTestContext()
  try {
    await run(test)
  } finally {
    await test.dispose(reason)
  }
}

/** 清空微任务队列（替代 `setTimeout(0)` 之类的真实时间等待）。 */
export function flush(times = 1): Promise<void> {
  let chain = Promise.resolve()
  for (let index = 0; index < times; index += 1) chain = chain.then(() => undefined)
  return chain
}

/** `waitFor` 的选项。 */
export interface WaitForOptions {
  /** 超时（ms），默认 1000；超时必抛错，绝不无限等。 */
  readonly timeoutMs?: number
  /** 失败信息里的标签（说清在等什么）。 */
  readonly label?: string
}

/**
 * 轮询等待条件成立。
 *
 * 用于「派发后事件循环里才会发生」的断言（替代固定 sleep）：
 * 每次轮询先清空微任务，再让出一个宏任务，保证 timer / IO 回调有机会跑。
 *
 * @throws `BahError('wait-timeout')`
 */
export async function waitFor(
  predicate: () => boolean,
  options: WaitForOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000
  const label = options.label ?? 'predicate'
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new BahError('wait-timeout', `test-support: 等待超时（${timeoutMs}ms）：${label}`, {
        label,
        timeoutMs,
      })
    }
    await flush()
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
}
