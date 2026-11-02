/**
 * Context 生命周期与贡献回滚单测。
 *
 * 用例 ID 与设计表逐一对应；补充用例（无 ID）用于覆盖 fail-loud 分支，
 * 保证「行覆盖 100%」不是靠空转断言凑出来的。
 */

import { describe, expect, it, vi } from 'vitest'

import { BahError } from '@bah/util'

import { createContext, defineService } from './index.ts'

import type { BahEventMap } from './index.ts'

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe('贡献与回滚', () => {
  it('T-CORE-003 effect 注册 + dispose → disposer 被逆序调用', async () => {
    const app = createContext()
    const calls: string[] = []

    await app.use({
      name: 'bank:audit',
      apply: (ctx) => {
        ctx.effect(() => {
          calls.push('first')
        })
        ctx.effect(() => {
          calls.push('second')
        })
      },
    })
    await app.start()
    await app.dispose('会话结束')

    expect(calls).toEqual(['second', 'first'])
  })

  it('T-CORE-019 dispose 原因透传：每个 disposer 都收到 reason', async () => {
    const app = createContext()
    const reasons: Array<string | undefined> = []

    await app.use({
      name: 'bank:audit',
      apply: (ctx) => {
        ctx.effect((reason) => {
          reasons.push(reason)
        })
        ctx.effect((reason) => {
          reasons.push(reason)
        })
      },
    })
    await app.start()
    await app.dispose('ticket-expired')

    expect(reasons).toEqual(['ticket-expired', 'ticket-expired'])
  })

  it('effect 返回的 disposer 可提前撤销，且 dispose 阶段不重复执行', async () => {
    const app = createContext()
    let calls = 0

    await app.use({
      name: 'bank:audit',
      apply: (ctx) => {
        const off = ctx.effect(() => {
          calls += 1
        })
        off()
        off()
      },
    })
    await app.start()
    await app.dispose()

    expect(calls).toBe(1)
  })

  it('dispose 之后再调 effect 返回的 disposer 也不会重复执行', async () => {
    const app = createContext()
    let calls = 0
    let off: () => void = () => {}

    await app.use({
      name: 'bank:audit',
      apply: (ctx) => {
        off = ctx.effect(() => {
          calls += 1
        })
      },
    })
    await app.start()
    await app.dispose()
    off()

    expect(calls).toBe(1)
  })
})

describe('生命周期三段', () => {
  it('install 阶段 apply 内可见 installing，start 完成后进入 ready', async () => {
    const app = createContext()
    const phases: string[] = []

    await app.use({
      name: 'bank:probe',
      apply: () => {
        phases.push(app.phase)
      },
    })
    expect(app.phase).toBe('idle')
    await app.start()
    phases.push(app.phase)

    expect(phases).toEqual(['installing', 'ready'])
  })

  it('start 幂等：已 ready 时再次 start 直接返回', async () => {
    const app = createContext()
    await app.start()
    await app.start()
    expect(app.phase).toBe('ready')
  })

  it('start 不允许重入：并发第二次 start 抛错', async () => {
    const app = createContext()
    await app.use({
      name: 'bank:slow',
      apply: async () => {
        await delay(5)
      },
    })

    const first = app.start()
    await expect(app.start()).rejects.toThrow(/不允许重入/)
    await first
    expect(app.phase).toBe('ready')
  })

  it('dispose 幂等；dispose 之后 start 抛错', async () => {
    const app = createContext()
    await app.start()
    await app.dispose()
    await app.dispose()

    expect(app.phase).toBe('disposed')
    await expect(app.start()).rejects.toThrow(/已 dispose/)
  })

  it('dispose 后注册插件 fail-loud（不存在隐式重开）', async () => {
    const app = createContext()
    await app.start()
    await app.dispose()

    expect(() => app.use({ name: 'bank:late', apply: () => {} })).toThrow(/不允许再注册插件/)
  })

  it('start 之后仍可注册插件：立即安装（覆盖裁剪线外的运行期注册）', async () => {
    const app = createContext()
    const order: string[] = []
    await app.start()

    await app.use({
      name: 'bank:hot',
      apply: () => {
        order.push('installed')
      },
    })

    expect(order).toEqual(['installed'])
  })
})

describe('服务与作用域', () => {
  it('provide / get / whenReady 经 Context 走通', async () => {
    const app = createContext()
    const model = defineService<{ ask(): string }>('bank:model')
    const ready = app.whenReady(model)

    const off = app.provide(model, { ask: () => 'ok' })

    await expect(ready).resolves.toBeDefined()
    expect(app.get(model).ask()).toBe('ok')

    off()
    expect(() => app.get(model)).toThrow(/未注册/)
  })

  it('作用域随 Context dispose 自动清理', async () => {
    const app = createContext()
    const sessionKey = defineService<string>('bank:session')

    app.scope.set(sessionKey, 's-1')
    expect(app.scope.get(sessionKey)).toBe('s-1')

    await app.start()
    await app.dispose()

    expect(app.scope.get(sessionKey)).toBeUndefined()
  })

  it('ready 之后 parallel 正常广播（广播守卫只拦 install 阶段）', async () => {
    const app = createContext()
    const seen: string[] = []

    await app.use({
      name: 'bank:notify',
      apply: (ctx) => {
        ctx.events.on('broadcast', async () => {
          seen.push('hit')
        })
      },
    })
    await app.start()
    await app.events.parallel('broadcast', {})

    expect(seen).toEqual(['hit'])
  })

  it('ctx.events 的五模式全部代理到同一事件源', async () => {
    const app = createContext()
    const order: string[] = []

    await app.use({
      name: 'bank:probe',
      apply: (ctx) => {
        ctx.events.on('agent/turn-stopping', () => {
          order.push('serial')
        })
        ctx.events.on('tools/pre-execute', async (value, next) => {
          order.push('waterfall')
          return next(value)
        })
        ctx.events.on('approval/request', () => 'allow')
      },
    })
    await app.start()

    await app.events.serial('agent/turn-stopping', {})
    await app.events.waterfall('tools/pre-execute', {})
    await expect(app.events.bail('approval/request', {})).resolves.toBe('allow')

    expect(order).toEqual(['serial', 'waterfall'])
  })
})

/**
 * C9：回滚期的失败隔离。
 *
 * 纪律：这些用例在修复前**全部是红的**（`dispose()` 会抛、后面的 disposer 不跑）。
 * 红的形态本身就是证据——不是"断言写错了"，是"清理被中断了"。
 *
 * 装配约定：观察者插件**先注册**、炸掉的插件**后注册**。回滚顺序是「插件逆序」，
 * 所以炸的时候观察者的监听器还活着——否则事件根本没人接，测出来的是假绿。
 */
describe('C9 回滚失败隔离', () => {
  /** 注册一个把清理过程记成序列的坏插件（第二个 effect 会炸）。 */
  async function withFailingDisposer(
    app: ReturnType<typeof createContext>,
    calls: string[],
    code = 'audit-sink-down',
  ): Promise<void> {
    await app.use({
      name: 'bank:audit',
      apply: (ctx) => {
        ctx.effect(() => {
          calls.push('first')
        })
        ctx.effect(() => {
          calls.push('boom')
          throw new BahError(code, '审计汇不可写')
        })
        ctx.effect(() => {
          calls.push('last')
        })
      },
    })
  }

  it('T-CORE-021 一个 disposer 抛错不阻断后续清理，dispose 不抛', async () => {
    const app = createContext()
    const calls: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await withFailingDisposer(app, calls)
      await app.start()

      await expect(app.dispose('test')).resolves.toBeUndefined()
      // 逆序：last → boom（炸）→ first（必须仍然执行）
      expect(calls).toEqual(['last', 'boom', 'first'])
    } finally {
      spy.mockRestore()
    }
  })

  it('T-CORE-022 失败以 context/rollback-failed 事件可见（bucket / effect / code）', async () => {
    const app = createContext()
    const calls: string[] = []
    const seen: BahEventMap['context/rollback-failed'][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await app.use({
        name: 'bank:observer',
        apply: (ctx) => {
          ctx.events.on('context/rollback-failed', (failure) => {
            seen.push(failure)
          })
        },
      })
      await withFailingDisposer(app, calls)
      await app.start()
      await app.dispose('test')

      expect(seen).toHaveLength(1)
      expect(seen[0]?.bucket).toBe('bank:audit')
      // 身份是「桶名#序号」，序号由 Context 单调计数生成（不是数组下标，下标会因重排漂移）
      expect(seen[0]?.effect).toMatch(/^bank:audit#\d+$/)
      expect(seen[0]?.code).toBe('audit-sink-down')
      expect(seen[0]?.message).toContain('审计汇不可写')
    } finally {
      spy.mockRestore()
    }
  })

  it('T-CORE-023 上报器自身失败也不中断回滚：其余 disposer 照跑、scope 已清空', async () => {
    const app = createContext()
    const calls: string[] = []
    const logs: string[] = []
    const sessionKey = defineService<string>('bank:session')
    app.scope.set(sessionKey, 's-1')
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(' '))
    })
    try {
      await app.use({
        name: 'bank:observer',
        apply: (ctx) => {
          // 声明 serial 而实际按 emit 派发：`select()` 会在派发前抛 event-mode-mismatch。
          // 这是"上报器自己炸"的唯一真实路径——监听器抛错本来就被 emitIsolated 隔离。
          ctx.events.on('context/rollback-failed', () => undefined, 'serial')
        },
      })
      await withFailingDisposer(app, calls)
      await app.start()

      await expect(app.dispose('test')).resolves.toBeUndefined()
      // 上报器炸了也挡不住同桶后续清理（逆序：last → boom → first）
      expect(calls).toEqual(['last', 'boom', 'first'])
      expect(app.scope.get(sessionKey)).toBeUndefined()
      // 上报失败必须留痕，不能静默
      expect(logs.join('\n')).toContain('rollback-report-failed')
    } finally {
      spy.mockRestore()
    }
  })

  it('T-CORE-024 一个监听器抛错不饿死其它监听器：坏监听器不阻断回滚、也不吞事件', async () => {
    const app = createContext()
    const calls: string[] = []
    const seen: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // 两个观察者：第一个抛错，第二个必须**仍然收到**事件。
      // 单监听器场景区分不出 emitIsolated 与 emit（外层的兜底 catch 会掩盖差异），
      // 真正的隔离语义是"一个坏监听器不饿死其它观察者"。
      await app.use({
        name: 'bank:observer-bad',
        apply: (ctx) => {
          ctx.events.on('context/rollback-failed', () => {
            throw new Error('listener-down')
          })
        },
      })
      await app.use({
        name: 'bank:observer-good',
        apply: (ctx) => {
          ctx.events.on('context/rollback-failed', (failure) => {
            seen.push(failure.code)
          })
        },
      })
      await withFailingDisposer(app, calls)
      await app.start()

      await expect(app.dispose('test')).resolves.toBeUndefined()
      expect(calls).toEqual(['last', 'boom', 'first'])
      expect(seen).toEqual(['audit-sink-down'])
    } finally {
      spy.mockRestore()
    }
  })

  it('T-CORE-025 dispose 之后 effect 抛 effect-after-dispose，且不登记任何条目', async () => {
    const app = createContext()
    let calls = 0
    await app.start()
    await app.dispose()

    let code: string | undefined
    try {
      app.effect(() => {
        calls += 1
      })
    } catch (error) {
      code = (error as { code?: string }).code
    }
    await app.dispose()

    expect(code).toBe('effect-after-dispose')
    expect(calls).toBe(0)
  })

  it('T-CORE-026 apply 失败且其 disposer 也炸：start 抛的仍是原始 apply 错误', async () => {
    const app = createContext()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await app.use({
        name: 'bank:broken',
        apply: (ctx) => {
          ctx.effect(() => {
            throw new BahError('audit-sink-down', '审计汇不可写')
          })
          throw new BahError('bad-settings', '坏配置')
        },
      })

      // 修复前：dispose('start-failed') 内部二次抛错，把 bad-settings 顶掉
      await expect(app.start()).rejects.toMatchObject({ code: 'bad-settings' })
    } finally {
      spy.mockRestore()
    }
  })
})
