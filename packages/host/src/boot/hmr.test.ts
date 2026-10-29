/**
 * config-only HMR（施工单 06 §6 的 T-PRF-007 / T-PRF-008）。
 *
 * 两件事必须同时成立：
 * 1. **配置真的换了**（patch 文件变化 → 校验 → 应用 → 通知）；
 * 2. **插件代码没换**（apply 次数不变；行增删要重启）。
 *
 * 时序相关的用例给真实 `fs.watchFile` 留了 100ms 起轮询的余量；
 * 语义相关的用例注入 watcher，不依赖机器快慢。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asSessionId, waitFor } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import type { HostPlugin } from '../plugin-manager/index.ts'

import { boot, type ProfileSummary } from './boot.ts'
import { readString, rejectUnknownKeys } from './config.ts'
import { startConfigHmr } from './hmr.ts'
import { createCatalog } from './plugins/index.ts'
import { testRunContext } from './test-run-context.ts'
import type { Bundle, ConfigLayer, PluginRow } from './profile-plugins.ts'

/** apply 次数探针（证明"插件代码不重载"）。 */
const applies: string[] = []

/** 夹具插件：只认 `label`。 */
const configPlugin: HostPlugin<{ label: string }> = {
  id: 'fx:cfg',
  plugin: {
    name: 'fx:cfg',
    apply(_ctx, config) {
      applies.push(config.label)
    },
  },
  validate(config) {
    rejectUnknownKeys(config, ['label'], 'fx:cfg')
    return { label: readString(config, 'label', 'fx:cfg') ?? 'default' }
  },
}

const BUNDLE: Bundle = { name: 'fx', rows: [{ id: 'fx:cfg' }] }
const CATALOG = createCatalog([configPlugin])

/** 读 JSON patch 文件成一层（不引入 YAML 依赖：HMR 只关心"重新读层"这件事）。 */
function readLayer(path: string): ConfigLayer {
  const rows = JSON.parse(readFileSync(path, 'utf8')) as readonly PluginRow[]
  return { layer: 'profile-patch', from: path, rows }
}

/** 写 patch 文件。 */
function writeLayer(path: string, rows: readonly PluginRow[]): void {
  writeFileSync(path, JSON.stringify(rows), 'utf8')
}

/** 起一个已启动的 app。 */
async function bootApp(path: string, profile: ProfileSummary) {
  return boot({
    profile,
    bundles: [BUNDLE],
    layers: [readLayer(path)],
    catalog: CATALOG,
    run: testRunContext({ sessionId: asSessionId('s-hmr'), now: () => 1_000 }),
  })
}

describe('T-PRF-007 config HMR', () => {
  it('T-PRF-007 改 patch 文件 → config 重载 → 插件代码不重载（apply 次数不变）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-hmr-'))
    const path = join(dir, 'patch.json')
    writeLayer(path, [{ id: 'fx:cfg', config: { label: 'before' } }])
    applies.length = 0

    const app = await bootApp(path, { name: 'fx', bundles: ['fx'], hmr: true })
    const changed: (readonly string[])[] = []
    app.ctx.events.on('bah/config-reload', (payload) => {
      changed.push(payload.changed)
    })

    const hmr = startConfigHmr({
      profile: app.profile,
      files: [path],
      reload: () => app.reload([readLayer(path)]),
    })

    try {
      expect(app.rows()[0]?.config).toEqual({ label: 'before' })
      expect(applies).toEqual(['before'])

      // 真实 watcher：等它先取一次 stat，再改文件
      await new Promise((resolve) => setTimeout(resolve, 100))
      writeLayer(path, [{ id: 'fx:cfg', config: { label: 'after' } }])
      await waitFor(() => changed.length > 0, { label: 'config 重载事件' })

      expect(changed[0]).toEqual(['fx:cfg'])
      expect(app.rows()[0]?.config).toEqual({ label: 'after' })
      // 插件代码没重载：apply 仍然只有启动时那一次
      expect(applies).toEqual(['before'])
    } finally {
      hmr?.stop()
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('注入 watcher 时：文件变化回调直接驱动重载（不依赖真实文件系统时序）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-hmr-'))
    const path = join(dir, 'patch.json')
    writeLayer(path, [{ id: 'fx:cfg', config: { label: 'before' } }])
    applies.length = 0

    const app = await bootApp(path, { name: 'fx', bundles: ['fx'], hmr: true })
    const listeners: (() => void)[] = []
    const stopped: string[] = []
    const hmr = startConfigHmr({
      profile: app.profile,
      files: [path],
      reload: () => app.reload([readLayer(path)]),
      watch: (file, listener) => {
        listeners.push(listener)
        return {
          stop() {
            stopped.push(file)
          },
        }
      },
    })

    try {
      expect(listeners).toHaveLength(1)
      writeLayer(path, [{ id: 'fx:cfg', config: { label: 'after' } }])
      listeners[0]?.()
      expect(app.rows()[0]?.config).toEqual({ label: 'after' })
      expect(applies).toEqual(['before'])

      hmr?.stop()
      hmr?.stop() // 幂等
      expect(stopped).toEqual([path])
      // 停止后手动重载不再生效
      expect(hmr?.reloadNow()).toBeUndefined()
    } finally {
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('T-PRF-008 headless HMR 关闭', () => {
  it('T-PRF-008 hmr: false 时不装任何监听（改文件无反应）', async () => {
    const calls: string[] = []
    const hmr = startConfigHmr({
      profile: { name: 'headless', bundles: ['base'], hmr: false },
      files: ['patch.yml'],
      reload: () => {
        throw new Error('不应该被调用')
      },
      watch: (file) => {
        calls.push(file)
        return { stop: () => {} }
      },
    })

    expect(hmr).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('hmr 开但没有 patch 文件：不装监听（没有可听的东西）', () => {
    const calls: string[] = []
    const hmr = startConfigHmr({
      profile: { name: 'fx', bundles: ['fx'], hmr: true },
      files: [],
      reload: () => ({ changed: [], requiresRestart: false, rows: [] }),
      watch: (file) => {
        calls.push(file)
        return { stop: () => {} }
      },
    })

    expect(hmr).toBeUndefined()
    expect(calls).toEqual([])
  })
})

describe('config HMR · 失败处理（补充用例）', () => {
  it('新配置非法：告警"继续使用旧配置"，旧配置保持不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-hmr-'))
    const path = join(dir, 'patch.json')
    writeLayer(path, [{ id: 'fx:cfg', config: { label: 'before' } }])
    applies.length = 0

    const app = await bootApp(path, { name: 'fx', bundles: ['fx'], hmr: true })
    const warnings: string[] = []
    let listener: (() => void) | undefined
    const hmr = startConfigHmr({
      profile: app.profile,
      files: [path],
      reload: () => app.reload([readLayer(path)]),
      warn: (message) => warnings.push(message),
      watch: (_file, next) => {
        listener = next
        return { stop: () => {} }
      },
    })

    try {
      writeLayer(path, [{ id: 'fx:cfg', config: { bad: true } }])
      listener?.()

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('继续使用旧配置')
      expect(app.rows()[0]?.config).toEqual({ label: 'before' })
    } finally {
      hmr?.stop()
      await app.dispose('test')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
