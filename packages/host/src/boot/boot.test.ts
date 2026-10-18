/**
 * boot：装配、注入顺序、回滚、fail-loud 与 config 重载（施工单 06 §4 / §6 的 T-PRF-004、T-PRF-005）。
 *
 * 用夹具（内存里的 bundle + 依赖清单）测，不依赖 `profiles/` 的真实文件：
 * boot 的每条分支都应该能在内存里跑到；真实文件的解析在 `@bah/cli` 的用例里。
 */

import { captureRejection, captureThrown } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { defineService } from '@bah/core'
import type { Context } from '@bah/core'

import type { HostPlugin } from '../plugin-manager/index.ts'

import { BOOT_PREFIX, bootError, readString, rejectUnknownKeys } from './config.ts'
import { boot, RUN_SERVICE, type BootOptions, type ProfileSummary } from './boot.ts'
import { createCatalog } from './plugins/index.ts'
import type { Bundle, ConfigLayer } from './profile-plugins.ts'

/** 装配过程的探针（顺序、回滚、apply 次数）。 */
interface Recorder {
  readonly applies: string[]
  readonly disposals: string[]
}

const PROFILE: ProfileSummary = { name: 'fx', bundles: ['fx'], hmr: true }

/** 夹具插件：apply 里记账 + 提供自己的服务（服务名 = `fx:svc:<id>`）。 */
function recorderPlugin(recorder: Recorder, id: string, inject: readonly string[] = []): HostPlugin<{ label: string }> {
  return {
    id,
    plugin: {
      name: id,
      ...(inject.length === 0 ? {} : { inject: [...inject] }),
      apply(ctx: Context, config) {
        recorder.applies.push(`${id}:${config.label}`)
        ctx.provide(defineService<{ id: string }>(`fx:svc:${id}`), { id })
        ctx.effect(() => {
          recorder.disposals.push(id)
        })
      },
    },
    validate(config) {
      rejectUnknownKeys(config, ['label'], id)
      return { label: readString(config, 'label', id) ?? 'default' }
    },
  }
}

/** 读 `bah:run` 的夹具（证明 boot injection 可用）。 */
function runAwarePlugin(recorder: Recorder, seen: string[]): HostPlugin<Record<string, never>> {
  return {
    id: 'fx:run',
    plugin: {
      name: 'fx:run',
      inject: [RUN_SERVICE.id],
      apply(ctx) {
        recorder.applies.push('fx:run')
        seen.push(String(ctx.get(RUN_SERVICE).sessionId))
      },
    },
    validate(config) {
      rejectUnknownKeys(config, [], 'fx:run')
      return {}
    },
  }
}

/** 会炸的夹具（启动失败回滚用）。 */
const boomPlugin: HostPlugin<Record<string, never>> = {
  id: 'fx:boom',
  plugin: {
    name: 'fx:boom',
    apply() {
      throw new Error('apply 炸了')
    },
  },
  validate(config) {
    rejectUnknownKeys(config, [], 'fx:boom')
    return {}
  },
}

const BUNDLE: Bundle = {
  name: 'fx',
  rows: [
    { id: 'fx:a', config: { label: 'a' } },
    { id: 'fx:b', config: {} },
  ],
}

/** 一次 boot 的常用选项。 */
function options(recorder: Recorder, overrides: Partial<BootOptions> = {}): BootOptions {
  return {
    profile: PROFILE,
    bundles: [BUNDLE],
    layers: [],
    catalog: createCatalog([
      recorderPlugin(recorder, 'fx:a'),
      recorderPlugin(recorder, 'fx:b'),
      recorderPlugin(recorder, 'fx:c'),
    ]),
    run: { sessionId: 's-boot' as BootOptions['run']['sessionId'], now: () => 1_000 },
    ...overrides,
  }
}

/** 一层 patch。 */
function layer(layerName: ConfigLayer['layer'], rows: ConfigLayer['rows']): ConfigLayer {
  return { layer: layerName, from: `${layerName}.yml`, rows }
}

describe('boot · 装配', () => {
  it('按行顺序 apply；配置默认值与 patch 生效；rows() 给出最终快照', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const app = await boot(
      options(recorder, {
        layers: [layer('profile-patch', [{ id: 'fx:b', config: { label: 'from-patch' } }])],
      }),
    )
    try {
      expect(recorder.applies).toEqual(['fx:a:a', 'fx:b:from-patch'])
      expect(app.rows().map((row) => [row.id, row.layer])).toEqual([
        ['fx:a', 'bundle'],
        ['fx:b', 'profile-patch'],
      ])
      expect(app.profile).toEqual(PROFILE)
      expect(String(app.run.sessionId)).toBe('s-boot')
      // RUN_SERVICE 可被插件注入取用
      expect(app.ctx.get(RUN_SERVICE).now()).toBe(1_000)
    } finally {
      await app.dispose('test')
    }
  })

  it('inject 决定激活顺序：行顺序反了也能先装被依赖的插件', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const app = await boot(
      options(recorder, {
        bundles: [
          {
            name: 'fx',
            rows: [{ id: 'fx:b' }, { id: 'fx:a' }],
          },
        ],
        catalog: createCatalog([
          recorderPlugin(recorder, 'fx:a'),
          recorderPlugin(recorder, 'fx:b', ['fx:svc:fx:a']),
        ]),
      }),
    )
    try {
      expect(recorder.applies).toEqual(['fx:a:default', 'fx:b:default'])
    } finally {
      await app.dispose('test')
    }
  })

  it('boot injection 在 apply 时已就绪（bah:run）', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const seen: string[] = []
    const app = await boot(
      options(recorder, {
        bundles: [{ name: 'fx', rows: [{ id: 'fx:run' }] }],
        catalog: createCatalog([runAwarePlugin(recorder, seen)]),
        run: { sessionId: 's-run' as BootOptions['run']['sessionId'], now: () => 2 },
      }),
    )
    try {
      expect(seen).toEqual(['s-run'])
    } finally {
      await app.dispose('test')
    }
  })

  it('dispose 逆序回滚全部贡献（后装先撤）', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const app = await boot(options(recorder))
    await app.dispose('测试收尾')
    expect(recorder.disposals).toEqual(['fx:b', 'fx:a'])
  })
})

describe('T-PRF-004 未知键', () => {
  it('T-PRF-004 载入即抛 bah-boot: 错误（未知配置键）', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const error = await captureRejection(() =>
      boot(
        options(recorder, {
          layers: [layer('overlay', [{ id: 'fx:a', config: { nope: true } }])],
        }),
      ),
    )
    expect(error.code).toBe('unknown-config-key')
    expect(error.message.startsWith(BOOT_PREFIX)).toBe(true)
    expect(error.message).toContain('nope')
    // 校验发生在任何插件 apply 之前
    expect(recorder.applies).toEqual([])
  })
})

describe('T-PRF-005 引用缺失插件', () => {
  it('T-PRF-005 载入即抛 bah-boot: 错误（依赖清单里没有该插件）', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const error = await captureRejection(() =>
      boot(
        options(recorder, {
          bundles: [{ name: 'fx', rows: [{ id: 'fx:a' }, { id: 'fx:nope' }] }],
        }),
      ),
    )
    expect(error.code).toBe('unknown-plugin')
    expect(error.message.startsWith(BOOT_PREFIX)).toBe(true)
    expect(recorder.applies).toEqual([])
  })

  it('patch 插入了未声明的插件同样载入即抛', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const error = await captureRejection(() =>
      boot(
        options(recorder, {
          layers: [layer('home-patch', [{ id: 'fx:x', use: 'fx:ghost' }])],
        }),
      ),
    )
    expect(error.code).toBe('unknown-plugin')
  })
})

describe('启动失败与回滚（补充用例）', () => {
  it('插件 apply 抛错 → boot-failed，且已装插件全部回滚', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const error = await captureRejection(() =>
      boot(
        options(recorder, {
          bundles: [{ name: 'fx', rows: [{ id: 'fx:a' }, { id: 'fx:boom' }] }],
          catalog: createCatalog([recorderPlugin(recorder, 'fx:a'), boomPlugin]),
        }),
      ),
    )
    expect(error.code).toBe('boot-failed')
    expect(error.message).toContain('apply 炸了')
    expect(recorder.disposals).toEqual(['fx:a'])
  })

  it('启动失败时 ba:run 也被撤掉（ctx 已 dispose）', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const error = await captureRejection(() =>
      boot(
        options(recorder, {
          bundles: [{ name: 'fx', rows: [{ id: 'fx:boom' }] }],
          catalog: createCatalog([boomPlugin]),
        }),
      ),
    )
    expect(error.code).toBe('boot-failed')
    expect(bootError('x', 'y').message).toBe('bah-boot: y')
  })
})

describe('config 重载（补充用例）', () => {
  it('配置变化：changed 命中、事件带 profile 与 changed、rows() 换成新快照、不重跑 apply', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const app = await boot(options(recorder))
    const events: unknown[] = []
    app.ctx.events.on('bah/config-reload', (payload) => {
      events.push(payload)
    })
    try {
      const result = app.reload([layer('overlay', [{ id: 'fx:a', config: { label: 'hot' } }])])
      expect(result.requiresRestart).toBe(false)
      expect(result.changed).toEqual(['fx:a'])
      expect(events).toEqual([{ profile: 'fx', changed: ['fx:a'] }])
      expect(app.rows()[0]).toMatchObject({ id: 'fx:a', layer: 'overlay', config: { label: 'hot' } })
      // 插件代码不重载：apply 仍然只跑过一次
      expect(recorder.applies).toEqual(['fx:a:a', 'fx:b:default'])
    } finally {
      await app.dispose('test')
    }
  })

  it('配置没变：changed 为空、不发事件', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const app = await boot(options(recorder))
    const events: unknown[] = []
    app.ctx.events.on('bah/config-reload', (payload) => {
      events.push(payload)
    })
    try {
      expect(app.reload([])).toMatchObject({ changed: [], requiresRestart: false })
      expect(events).toEqual([])
    } finally {
      await app.dispose('test')
    }
  })

  it('行增删（结构变化）：requiresRestart、打印提示、不发事件、rows 不变', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const warnings: string[] = []
    const app = await boot(options(recorder, { warn: (message) => warnings.push(message) }))
    try {
      const before = app.rows()
      const result = app.reload([layer('overlay', [{ id: 'fx:c', use: 'fx:c' }])])
      expect(result.requiresRestart).toBe(true)
      expect(result.changed).toEqual([])
      expect(app.rows()).toEqual(before)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('重启')
    } finally {
      await app.dispose('test')
    }
  })

  it('新配置非法：reload 抛错且保持旧配置（调用方负责告警）', async () => {
    const recorder: Recorder = { applies: [], disposals: [] }
    const app = await boot(options(recorder))
    try {
      const before = app.rows()
      const error = captureThrown(() =>
        app.reload([layer('overlay', [{ id: 'fx:a', config: { bad: 1 } }])]),
      )
      expect(error.code).toBe('unknown-config-key')
      expect(app.rows()).toEqual(before)
    } finally {
      await app.dispose('test')
    }
  })
})
