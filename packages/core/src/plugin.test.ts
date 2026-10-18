/**
 * 插件装配单测（施工单 02 §2 / §5 / §7 / §10）。
 *
 * 覆盖三段生命周期、inject 等待与成环、config fail-loud、同名覆盖回滚。
 */

import { describe, expect, it } from 'vitest'

import Schema from 'schemastery'

import type { PluginV2 } from './api.ts'
import { createContext, defineService } from './index.ts'
import { findUnknownKeys, resolveConfig } from './plugin.ts'

/**
 * 测试唯一收窄点：故意传入类型不符的配置，验证 fail-loud。
 *
 * 业务代码不许这么写（施工单 00 §10「不留 as unknown」）；测试不这样写就造不出非法输入。
 */
const asConfig = (input: unknown): never => input as never

describe('三段生命周期', () => {
  it('T-CORE-001 parallel 有未完成监听器 → install 阶段广播派发报错', async () => {
    const app = createContext()
    let notified = false

    await app.use({
      name: 'core:probe',
      apply: async (ctx) => {
        ctx.events.on('fake-event', async () => {
          notified = true
        })
        await ctx.events.parallel('fake-event', {})
      },
    })

    await expect(app.start()).rejects.toThrow(/有监听器未完成/)
    // 广播守卫在产生任何副作用之前就抛：监听器一次都没跑
    expect(notified).toBe(false)
  })

  it('T-CORE-002 插件 apply 抛错 → 应用退出，错误带 bah-core: 前缀与插件名', async () => {
    const app = createContext()
    await app.use({
      name: 'bank:boom',
      apply: () => {
        throw new Error('boom')
      },
    })

    await expect(app.start()).rejects.toThrow(/^bah-core: 插件 bank:boom 的 apply 失败：boom$/)
    expect(app.phase).toBe('disposed')
    await expect(app.start()).rejects.toThrow(/已 dispose/)
  })

  it('apply 抛出非 Error 也必须留下可读文本（禁止静默吞错）', async () => {
    const app = createContext()
    await app.use({
      name: 'bank:odd',
      apply: () => {
        throw 'raw-failure'
      },
    })

    await expect(app.start()).rejects.toThrow(/raw-failure/)
  })

  it('apply 失败会回滚已装入插件的贡献（不留半初始化应用）', async () => {
    const app = createContext()
    const rolled: string[] = []

    await app.use({
      name: 'bank:first',
      apply: (ctx) => {
        ctx.effect(() => {
          rolled.push('first-rollback')
        })
      },
    })
    await app.use({
      name: 'bank:second',
      apply: () => {
        throw new Error('装不上')
      },
    })

    await expect(app.start()).rejects.toThrow(/装不上/)
    expect(rolled).toEqual(['first-rollback'])
  })
})

describe('inject 服务导入', () => {
  it('T-CORE-004 inject 依赖后启动 → 等待插件在依赖 ready 后收到实例', async () => {
    const app = createContext()
    const model = defineService<{ ask(): string }>('bank:model')
    let received: { ask(): string } | undefined

    // 消费者先注册：install 第一轮它必须挂起，等 provider 装上后再继续
    await app.use({
      name: 'bank:chat',
      inject: ['bank:model'],
      apply: (ctx) => {
        received = ctx.get(model)
      },
    })
    await app.use({
      name: 'bank:model',
      apply: (ctx) => {
        ctx.provide(model, { ask: () => 'ok' })
      },
    })

    expect(received).toBeUndefined()
    await app.start()
    expect(received?.ask()).toBe('ok')
  })

  it('T-CORE-005 inject 成环 → 启动抛错并打印环路径', async () => {
    const app = createContext()
    const neverInstalled = (): void => {
      throw new Error('成环时不应安装任何插件')
    }

    await app.use({ name: 'bank:alpha', inject: ['bank:beta'], apply: neverInstalled })
    await app.use({ name: 'bank:beta', inject: ['bank:alpha'], apply: neverInstalled })

    await expect(app.start()).rejects.toThrow(
      /服务等待成环：bank:alpha → bank:beta → bank:alpha/,
    )
  })

  it('inject 依赖无人提供 → 抛错并列出未就绪依赖', async () => {
    const app = createContext()
    await app.use({ name: 'bank:chat', inject: ['bank:model'], apply: () => {} })

    await expect(app.start()).rejects.toThrow(/服务依赖无法满足：bank:chat ← \[bank:model\]/)
  })

  it('ready 后注册的插件同样要等 inject 就绪才允许安装', async () => {
    const app = createContext()
    await app.start()

    await expect(
      app.use({ name: 'bank:late', inject: ['bank:model'], apply: () => {} }),
    ).rejects.toThrow(/服务依赖无法满足/)
  })
})

describe('config 校验（fail-loud）', () => {
  const budget: PluginV2<{ limit: number }> = {
    name: 'bank:budget',
    config: Schema.object({ limit: Schema.number() }),
    apply: () => {},
  }

  it('T-CORE-014 config 未知键 → 载入即抛', () => {
    const app = createContext()
    let applied = false

    expect(() =>
      app.use(
        { ...budget, apply: () => { applied = true } },
        asConfig({ limit: 1, ghost: 2 }),
      ),
    ).toThrow(/invalid config for bank:budget: 未知配置键：ghost/)
    expect(applied).toBe(false)
  })

  it('T-CORE-015 config 类型错误 → 载入即抛', () => {
    const app = createContext()

    expect(() =>
      app.use(
        { ...budget, apply: () => {} },
        asConfig({ limit: '很多' }),
      ),
    ).toThrow(/invalid config for bank:budget: .*expected number/)
  })

  it('T-CORE-016 config 正则编译失败 → 载入即抛', () => {
    const app = createContext()
    const rules: PluginV2<{ pattern: string }> = {
      name: 'bank:rules',
      config: Schema.object({
        // 正则**编译**发生在配置校验里：编译失败即载入即抛（施工单 02 T-CORE-016）
        pattern: Schema.transform(Schema.string(), (value) => {
          new RegExp(value)
          return value
        }),
      }),
      apply: () => {},
    }
    let applied = false

    expect(() =>
      app.use(
        { ...rules, apply: () => { applied = true } },
        asConfig({ pattern: '([' }),
      ),
    ).toThrow(/invalid config for bank:rules: .*Invalid regular expression/)
    expect(applied).toBe(false)
  })

  it('config 通过校验后 apply 拿到补齐默认值的配置', async () => {
    const app = createContext()
    const schema = Schema.object({ limit: Schema.number().default(100) })
    let received: unknown

    await app.use(
      {
        name: 'bank:budget',
        config: schema,
        apply: (_ctx, config) => {
          received = config
        },
      },
      asConfig({}),
    )
    await app.start()

    expect(received).toEqual({ limit: 100 })
  })

  it('有 schema 但调用方不传 config → 按空对象校验并补默认值', async () => {
    const app = createContext()
    const schema = Schema.object({ limit: Schema.number().default(5) })
    let received: unknown

    await app.use({
      name: 'bank:budget',
      config: schema,
      apply: (_ctx, config) => {
        received = config
      },
    })
    await app.start()

    expect(received).toEqual({ limit: 5 })
  })

  it('没有 config schema 时不校验，原样透传（缺省补空对象）', () => {
    const plugin: PluginV2 = { name: 'bank:plain', apply: () => {} }
    expect(resolveConfig(plugin, undefined)).toEqual({})
    expect(resolveConfig(plugin, { any: 'thing' })).toEqual({ any: 'thing' })
  })

  it('findUnknownKeys 只判对象类 schema 的顶层键', () => {
    const object = Schema.object({ limit: Schema.number() })
    const union = Schema.union([Schema.number(), Schema.string()])

    expect(findUnknownKeys(union, { limit: 1 })).toEqual([])
    expect(findUnknownKeys(object, 42)).toEqual([])
    expect(findUnknownKeys(object, null)).toEqual([])
    expect(findUnknownKeys(object, { limit: 1, ghost: 2 })).toEqual(['ghost'])
  })
})

describe('同名插件覆盖', () => {
  it('T-CORE-020 后者覆盖前者，前者 effect 回滚', async () => {
    const app = createContext()
    const log: string[] = []

    await app.use({
      name: 'bank:tools',
      apply: (ctx) => {
        ctx.effect(() => {
          log.push('first:rollback')
        })
        log.push('first:apply')
      },
    })
    await app.start()

    await app.use({
      name: 'bank:tools',
      apply: () => {
        log.push('second:apply')
      },
    })

    expect(log).toEqual(['first:apply', 'first:rollback', 'second:apply'])
  })
})

describe('插件工厂', () => {
  it('createContext 每次返回独立应用实例', () => {
    const first = createContext()
    const second = createContext()
    expect(first).not.toBe(second)
    expect(first.events).not.toBe(second.events)
  })
})
