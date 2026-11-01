/**
 * `--dump-config` 输出。
 *
 * 只测渲染：`renderDumpConfig(profile, rows)` 是纯函数，行快照由调用方给。
 * "真实四层文件 → 四层标注"的端到端断言在 `cli/run.test.ts` 里另有一份。
 */

import { describe, expect, it } from 'vitest'

import type { ValidatedRow } from '@bah/host'

import { renderDumpConfig } from './dump-config.ts'

/** 造一行已校验的行（plugin/settings 是渲染需要的两样东西）。 */
function row(id: string, layer: ValidatedRow['layer'], from: string, settings: unknown): ValidatedRow {
  return {
    id,
    use: id,
    config: {},
    layer,
    from,
    plugin: { name: id, apply() {} },
    settings,
  }
}

describe('T-PRF-006 dump-config', () => {
  it('T-PRF-006 输出含来源层标注（bundle / profile patch / home patch / overlay）', () => {
    const text = renderDumpConfig({ name: 'web', bundles: ['base', 'web-app'], hmr: true }, [
      row('core:model', 'bundle', 'base', { provider: 'deepseek', model: 'deepseek-chat' }),
      row('core:session', 'profile-patch', 'profiles/web/patch.yml', {}),
      row('core:agent', 'home-patch', '/home/u/.bah/bah.patch.yml', { channel: 'web' }),
      row('demo:echo', 'overlay', 'dev.yml', { prefix: '[dev]' }),
    ])

    expect(text).toContain('profile web（bundles: base + web-app；config HMR: 开）')
    expect(text).toContain('bundle:base')
    expect(text).toContain('profile-patch:profiles/web/patch.yml')
    expect(text).toContain('home-patch:/home/u/.bah/bah.patch.yml')
    expect(text).toContain('overlay:dev.yml')
    // 最终配置是单行 JSON（整块替换后的样子，默认值已补齐）
    expect(text).toContain('{"provider":"deepseek","model":"deepseek-chat"}')
    // 每行都在，且给了总行数
    expect(text).toContain('bah: 共 4 行')
    expect(text.split('\n').filter((line) => line.startsWith('core:') || line.startsWith('demo:'))).toHaveLength(4)
    // 末尾不带换行（由调用方决定）
    expect(text.endsWith('\n')).toBe(false)
  })

  it('空行集：仍打印表头、层序说明与 0 行', () => {
    const text = renderDumpConfig({ name: 'headless', bundles: ['base'], hmr: false }, [])
    expect(text).toContain('config HMR: 关')
    expect(text).toContain('层序 bundle → profile patch → home patch → overlay')
    expect(text).toContain('bah: 共 0 行')
  })
})
