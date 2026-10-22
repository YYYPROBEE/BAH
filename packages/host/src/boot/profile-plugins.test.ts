/**
 * 层序合并器（施工单 06 §6 的 T-PRF-001 / T-PRF-002 / T-PRF-003）。
 *
 * 三条用例钉住的是**语义**而不是实现：
 * - 后层覆盖前层（层序）；
 * - 覆盖是**整块替换**（patch 只写一个字段，其余走插件默认值，而不是深合并）；
 * - id 未命中即插入新行（必须声明 use）。
 */

import { captureThrown } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { PluginManager } from '../plugin-manager/index.ts'
import type { HostPlugin } from '../plugin-manager/index.ts'

import { bootError, asRecord, readPositiveInteger, readString, rejectUnknownKeys } from './config.ts'
import {
  diffRows,
  mergeLayers,
  normalizeRow,
  sameStructure,
  type Bundle,
  type ConfigLayer,
  type PluginRow,
} from './profile-plugins.ts'
import { createCatalog } from './plugins/index.ts'

/** 有默认值的夹具插件：三段（必修 / 可选 / 嵌套），用来证明"未写字段走默认值"。 */
const alphaPlugin: HostPlugin<{ alpha: number; beta: string; nested: { flag: boolean } }> = {
  id: 'fx:alpha',
  plugin: { name: 'fx:alpha', apply() {} },
  validate(config) {
    rejectUnknownKeys(config, ['alpha', 'beta', 'nested'], 'fx:alpha')
    return {
      alpha: readPositiveInteger(config, 'alpha', 'fx:alpha') ?? 1,
      beta: readString(config, 'beta', 'fx:alpha') ?? 'default-beta',
      nested:
        config['nested'] === undefined
          ? { flag: true }
          : (asRecord(config['nested'], 'fx:alpha.nested') as { flag: boolean }),
    }
  },
}

/** 无配置项的夹具插件。 */
const betaPlugin: HostPlugin<Record<string, never>> = {
  id: 'fx:beta',
  plugin: { name: 'fx:beta', apply() {} },
  validate(config) {
    rejectUnknownKeys(config, [], 'fx:beta')
    return {}
  },
}

const CATALOG = { 'fx:alpha': alphaPlugin, 'fx:beta': betaPlugin }

/** 两行 bundle。 */
const BUNDLE: Bundle = {
  name: 'fx',
  rows: [
    { id: 'fx:alpha', config: { alpha: 5, beta: 'from-bundle', nested: { flag: false } } },
    { id: 'fx:beta' },
  ],
}

/** 造一层 patch。 */
function layer(layerName: ConfigLayer['layer'], rows: readonly PluginRow[]): ConfigLayer {
  return { layer: layerName, from: `${layerName}.yml`, rows }
}

describe('T-PRF-001 层序覆盖', () => {
  it('T-PRF-001 home patch 覆盖 profile patch 的同 id 行（顺序仍是 profile patch 在前）', () => {
    const rows = mergeLayers(
      [BUNDLE],
      [
        layer('profile-patch', [{ id: 'fx:alpha', config: { beta: 'from-profile' } }]),
        layer('home-patch', [{ id: 'fx:alpha', config: { beta: 'from-home' } }]),
      ],
    )

    const alpha = rows.find((row) => row.id === 'fx:alpha')
    expect(alpha?.config).toEqual({ beta: 'from-home' })
    expect(alpha?.layer).toBe('home-patch')
    expect(alpha?.from).toBe('home-patch.yml')
    // 没有被后层碰过的行保持原层与原始顺序
    expect(rows.map((row) => row.id)).toEqual(['fx:alpha', 'fx:beta'])
    expect(rows[1]?.layer).toBe('bundle')
    expect(rows[1]?.from).toBe('fx')
  })

  it('四层全上时最外层 overlay 胜出（层序 bundle → profile → home → overlay）', () => {
    const rows = mergeLayers(
      [BUNDLE],
      [
        layer('profile-patch', [{ id: 'fx:alpha', config: { beta: 'p' } }]),
        layer('home-patch', [{ id: 'fx:alpha', config: { beta: 'h' } }]),
        layer('overlay', [{ id: 'fx:alpha', config: { beta: 'o' } }]),
      ],
    )

    expect(rows[0]).toMatchObject({ id: 'fx:alpha', layer: 'overlay', config: { beta: 'o' } })
  })
})

describe('T-PRF-002 整块替换', () => {
  it('T-PRF-002 patch 只写一个字段：合并结果里没有旧字段残留，其余走插件默认值', () => {
    const merged = mergeLayers(
      [BUNDLE],
      [layer('profile-patch', [{ id: 'fx:alpha', config: { beta: 'from-patch' } }])],
    )

    // ① 合并层只做整块替换：旧行的 alpha / nested **整体消失**（不是深合并）
    expect(merged[0]?.config).toEqual({ beta: 'from-patch' })

    // ② 插件默认值兜底：校验后 alpha / nested 回到默认值
    const validated = new PluginManager(CATALOG).validate(merged)
    expect(validated[0]?.settings).toEqual({
      alpha: 1,
      beta: 'from-patch',
      nested: { flag: true },
    })
  })

  it('没写 config 的 patch 行 = 用插件默认值（不是"保持原配置"）', () => {
    const merged = mergeLayers([BUNDLE], [layer('overlay', [{ id: 'fx:alpha' }])])
    expect(merged[0]?.config).toEqual({})
    expect(new PluginManager(CATALOG).validate(merged)[0]?.settings).toEqual({
      alpha: 1,
      beta: 'default-beta',
      nested: { flag: true },
    })
  })
})

describe('T-PRF-003 插入新行', () => {
  it('T-PRF-003 无 id 冲突时插入生效（追加到末尾，来源层是插入它的那层）', () => {
    const rows = mergeLayers(
      [BUNDLE],
      [layer('profile-patch', [{ id: 'fx:gamma', use: 'fx:beta', config: {} }])],
    )

    expect(rows.map((row) => row.id)).toEqual(['fx:alpha', 'fx:beta', 'fx:gamma'])
    expect(rows[2]).toMatchObject({ id: 'fx:gamma', use: 'fx:beta', layer: 'profile-patch' })
  })

  it('插入行不写 use：载入即抛（patch 不能凭空造插件）', () => {
    const thrown = captureThrown(() =>
      mergeLayers([BUNDLE], [layer('overlay', [{ id: 'fx:gamma' }])]),
    )
    expect(thrown.code).toBe('row-without-plugin')
    expect(thrown.message).toContain('bah-boot: ')
  })
})

describe('合并器 · 结构校验与差异（补充用例）', () => {
  it('空 bundle 直接拒绝（空组合没有意义）', () => {
    expect(captureThrown(() => mergeLayers([{ name: 'fx', rows: [] }], [])).code).toBe('empty-bundle')
  })

  it('同一 bundle 内 id 重复 / 同一层内 id 重复都载入即抛', () => {
    expect(
      captureThrown(() =>
        mergeLayers([{ name: 'fx', rows: [{ id: 'a' }, { id: 'a' }] }], []),
      ).code,
    ).toBe('duplicate-row')
    expect(
      captureThrown(() =>
        mergeLayers(
          [BUNDLE],
          [layer('overlay', [{ id: 'a', use: 'fx:beta' }, { id: 'a', use: 'fx:beta' }])],
        ),
      ).code,
    ).toBe('duplicate-row')
  })

  it('normalizeRow：缺 id / use 空 / config 非对象 → invalid-row；id 与 use 会 trim', () => {
    expect(captureThrown(() => normalizeRow({ id: '' }, 'x')).code).toBe('invalid-row')
    expect(captureThrown(() => normalizeRow({ id: ' a ', use: '  ' }, 'x')).code).toBe('invalid-row')
    expect(
      captureThrown(() => normalizeRow({ id: 'a', config: [] as unknown as Record<string, unknown> }, 'x')).code,
    ).toBe('invalid-row')
    expect(normalizeRow({ id: ' a ', use: ' b ' }, 'x')).toEqual({ id: 'a', use: 'b' })
  })

  it('sameStructure：长度 / use / 顺序任一变化即视为结构变化', () => {
    const base = mergeLayers([BUNDLE], [])
    expect(sameStructure(base, mergeLayers([BUNDLE], []))).toBe(true)
    expect(sameStructure(base, base.slice(0, 1))).toBe(false)
    expect(
      sameStructure(base, [{ ...base[0]!, use: 'fx:beta' }, base[1]!]),
    ).toBe(false)
  })

  it('diffRows：键序不同不算改动，值变才算；新增行不算改动', () => {
    const before = mergeLayers([BUNDLE], [])
    const reordered = before.map((row) =>
      row.id === 'fx:alpha' ? { ...row, config: { nested: { flag: false }, beta: 'from-bundle', alpha: 5 } } : row,
    )
    expect(diffRows(before, reordered)).toEqual([])

    const changed = before.map((row) => (row.id === 'fx:alpha' ? { ...row, config: { alpha: 6 } } : row))
    expect(diffRows(before, changed)).toEqual(['fx:alpha'])
  })

  it('bootError 带统一前缀与理由码', () => {
    const error = bootError('demo-code', '理由', { detail: 1 })
    expect(error.code).toBe('demo-code')
    expect(error.message).toBe('bah-boot: 理由')
    expect(error.detail).toEqual({ detail: 1 })
  })
})

describe('插件管理器（补充用例）', () => {
  it('引用依赖清单外的插件 → unknown-plugin，并列出已声明插件', () => {
    const thrown = captureThrown(() =>
      new PluginManager(CATALOG).validate([
        { id: 'x', use: 'fx:nope', config: {}, layer: 'bundle', from: 'fx' },
      ]),
    )
    expect(thrown.code).toBe('unknown-plugin')
    expect(thrown.message).toContain('fx:alpha')
  })

  it('同一插件挂两次 → duplicate-plugin；行 id 重复 → duplicate-row', () => {
    const manager = new PluginManager(CATALOG)
    expect(
      captureThrown(() =>
        manager.validate([
          { id: 'a', use: 'fx:beta', config: {}, layer: 'bundle', from: 'fx' },
          { id: 'b', use: 'fx:beta', config: {}, layer: 'bundle', from: 'fx' },
        ]),
      ).code,
    ).toBe('duplicate-plugin')
    expect(
      captureThrown(() =>
        manager.validate([
          { id: 'a', use: 'fx:beta', config: {}, layer: 'bundle', from: 'fx' },
          { id: 'a', use: 'fx:alpha', config: {}, layer: 'bundle', from: 'fx' },
        ]),
      ).code,
    ).toBe('duplicate-row')
  })

  it('配置校验错误原样上抛（保留精确理由码），非 boot 错误包一层 invalid-config', () => {
    const manager = new PluginManager(CATALOG)
    const unknownKey = captureThrown(() =>
      manager.validate([
        { id: 'fx:alpha', use: 'fx:alpha', config: { nope: 1 }, layer: 'bundle', from: 'fx' },
      ]),
    )
    expect(unknownKey.code).toBe('unknown-config-key')

    const boom = new PluginManager({
      'fx:boom': {
        id: 'fx:boom',
        plugin: { name: 'fx:boom', apply() {} },
        validate() {
          throw new Error('配置炸了')
        },
      },
    })
    const wrapped = captureThrown(() =>
      boom.validate([{ id: 'fx:boom', use: 'fx:boom', config: {}, layer: 'bundle', from: 'fx' }]),
    )
    expect(wrapped.code).toBe('invalid-config')
    expect(wrapped.message).toContain('配置炸了')
  })

  it('清单查询：ids / has / get', () => {
    const manager = new PluginManager(CATALOG)
    expect(manager.ids()).toEqual(['fx:alpha', 'fx:beta'])
    expect(manager.has('fx:alpha')).toBe(true)
    expect(manager.has('fx:nope')).toBe(false)
    // 清单存擦除形态：name/validate 保持不变，配置类型由 validate 负责
    const found = manager.get('fx:beta')
    expect(found.id).toBe('fx:beta')
    expect(found.plugin.name).toBe('fx:beta')
    expect(found.validate).toBe(betaPlugin.validate)
  })

  it('createCatalog：清单内 id 重复即抛', () => {
    expect(captureThrown(() => createCatalog([alphaPlugin, alphaPlugin])).code).toBe('duplicate-plugin')
    expect(Object.keys(createCatalog([alphaPlugin, betaPlugin]))).toEqual(['fx:alpha', 'fx:beta'])
  })
})
