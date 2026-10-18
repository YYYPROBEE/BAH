/**
 * 作用域与键屏蔽代理单测（施工单 02 §6 / §10）。
 */

import { describe, expect, it } from 'vitest'

import { createContext, defineService } from './index.ts'
import { BahScope } from './scope.ts'

describe('BahScope', () => {
  it('set 返回幂等 disposer；clear 清空全部键', () => {
    const scope = new BahScope()
    const key = defineService<string>('bank:session')

    expect(scope.get(key)).toBeUndefined()
    const off = scope.set(key, 's-1')
    expect(scope.get(key)).toBe('s-1')

    off()
    off()
    expect(scope.get(key)).toBeUndefined()

    scope.set(key, 's-2')
    scope.clear()
    expect(scope.get(key)).toBeUndefined()
  })
})

describe('isolate（键屏蔽代理）', () => {
  it('T-CORE-018 屏蔽键取不到，事件与作用域仍共享父级', async () => {
    const app = createContext()
    const model = defineService<{ ask(): string }>('bank:model')
    const account = defineService<string>('bank:account')
    app.provide(model, { ask: () => 'ok' })
    app.provide(account, 'acct-42')

    const isolated = app.isolate(model)

    expect(isolated.events).toBe(app.events)
    expect(isolated.scope).toBe(app.scope)
    expect(() => isolated.get(model)).toThrow(/已被 isolate 屏蔽/)
    expect(isolated.get(account)).toBe('acct-42')

    // 事件共享：隔离上下文注册的监听器，父级派发能收到
    const seen: string[] = []
    isolated.events.on('shared-event', () => {
      seen.push('hit')
    })
    app.events.emit('shared-event', {})
    expect(seen).toEqual(['hit'])
  })

  it('isolate 的 provide / whenReady / effect / start / dispose 全部委托父级', async () => {
    const app = createContext()
    const hidden = defineService<number>('bank:hidden')
    const fresh = defineService<number>('bank:fresh')
    app.provide(hidden, 1)

    const isolated = app.isolate(hidden)
    const off = isolated.provide(fresh, 2)
    expect(app.get(fresh)).toBe(2)
    await expect(isolated.whenReady(hidden)).resolves.toBe(1)

    const rolled: string[] = []
    isolated.effect(() => {
      rolled.push('kernel-effect')
    })

    await isolated.start()
    expect(app.phase).toBe('ready')

    off()
    await isolated.dispose('闭环')
    expect(app.phase).toBe('disposed')
    expect(rolled).toEqual(['kernel-effect'])
  })

  it('嵌套 isolate 逐层叠加屏蔽集合', async () => {
    const app = createContext()
    const first = defineService<number>('bank:first')
    const second = defineService<number>('bank:second')
    const open = defineService<number>('bank:open')
    app.provide(first, 1)
    app.provide(second, 2)
    app.provide(open, 3)

    const inner = app.isolate(first).isolate(second)

    expect(() => inner.get(first)).toThrow(/屏蔽/)
    expect(() => inner.get(second)).toThrow(/屏蔽/)
    expect(inner.get(open)).toBe(3)
  })
})
