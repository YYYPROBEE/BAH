/**
 * 适配器注册表。
 *
 * 注册表决定"哪条路由落到哪个平台、哪个账号"：账号不匹配时必须 `undefined`
 * （否则多账号部署会串号）；重复 id 与空账号清单是装配错误，必须启动即失败，
 * 不能后者静默覆盖前者。
 */

import { describe, expect, it } from 'vitest'

import type { PlatformAdapter } from '@bah/channels'

import { createRegistry } from '../src/platform/registry.ts'

/** 最小适配器桩：注册表只认 id 与账号，不调用 verify/parse。 */
function adapterOf(id: string): PlatformAdapter {
  return {
    id,
    capabilities: {
      passiveReply: true,
      asyncPush: true,
      interactiveCards: false,
      threads: false,
      maxTextBytes: 2048,
    },
    verify: () => ({ ok: true }),
    parse: () => ({ kind: 'reject', status: 400, code: 'test-only' }),
  }
}

describe('createRegistry', () => {
  it('缺省每个平台只服务 default；未知平台 / 未知账号一律 undefined', () => {
    const registry = createRegistry([adapterOf('wechat')])
    expect(registry.get('wechat', 'default')?.id).toBe('wechat')
    expect(registry.get('wechat', 'other')).toBeUndefined()
    expect(registry.get('mock', 'default')).toBeUndefined()
    expect(registry.size()).toBe(1)
  })

  it('显式账号清单：只放行列出的账号，不再隐式包含 default', () => {
    const registry = createRegistry([adapterOf('wechat')], { wechat: ['acct-a', 'acct-b'] })
    expect(registry.get('wechat', 'acct-b')?.id).toBe('wechat')
    expect(registry.get('wechat', 'default')).toBeUndefined()
    expect(registry.list()).toEqual([{ id: 'wechat', accounts: ['acct-a', 'acct-b'] }])
  })

  it('重复适配器 id → 装配期直接抛错（不静默后者覆盖前者）', () => {
    expect(() => createRegistry([adapterOf('wechat'), adapterOf('wechat')])).toThrow(
      '适配器 id 重复注册：wechat',
    )
  })

  it('空账号清单 → 装配期直接抛错（平台注册了却谁也到不了，属于配置错误）', () => {
    expect(() => createRegistry([adapterOf('wechat')], { wechat: [] })).toThrow(
      'wechat 的账号清单不能为空',
    )
  })
})
