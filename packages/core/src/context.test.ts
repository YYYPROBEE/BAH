/**
 * Context 生命周期与贡献回滚单测（施工单 02 §2 / §10）。
 *
 * 用例 ID 与施工单 §10 表逐一对应；补充用例（无 ID）用于覆盖 fail-loud 分支，
 * 保证「行覆盖 100%」不是靠空转断言凑出来的。
 */

import { describe, expect, it } from 'vitest'

import { createContext, defineService } from './index.ts'

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
