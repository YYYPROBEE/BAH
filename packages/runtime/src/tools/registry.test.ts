/**
 * 工具注册表单测（施工单 03 §3 第 6 步 / §4 的 T-TOOL-001、T-TOOL-002）。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { ToolRegistry } from './registry.ts'
import type { ToolDefinition } from './types.ts'

/** 最小工具定义（只关心注册表行为，不关心执行语义）。 */
const probe = (name: string): ToolDefinition => ({
  name,
  description: `${name} 的测试定义`,
  schema: { type: 'object' },
  tier: { level: 'green' },
  execute: async () => 'ok',
})

describe('ToolRegistry', () => {
  it('T-TOOL-001 注册即 disposer：卸载后再调用 → 未注册错', () => {
    const registry = new ToolRegistry()
    const off = registry.register(probe('bank:probe'))

    expect(registry.has('bank:probe')).toBe(true)
    expect(registry.names()).toEqual(['bank:probe'])
    expect(registry.list()).toHaveLength(1)

    off()
    off() // 幂等

    expect(registry.has('bank:probe')).toBe(false)
    const error = captureThrown(() => registry.get('bank:probe'))
    expect(error.code).toBe('tool-missing')
    expect(error.message).toContain('bank:probe')
  })

  it('T-TOOL-002 工具重名 → 注册时抛错', () => {
    const registry = new ToolRegistry()
    registry.register(probe('bank:probe'))

    const error = captureThrown(() => registry.register(probe('bank:probe')))
    expect(error.code).toBe('tool-duplicate')
    expect(registry.names()).toEqual(['bank:probe'])
  })

  it('工具名为空 → 载入即抛（模型按名字寻址）', () => {
    const registry = new ToolRegistry()
    expect(captureThrown(() => registry.register(probe(''))).code).toBe('tool-name-empty')
  })

  it('list() 保持注册顺序（模型侧 schema 装配按此顺序）', () => {
    const registry = new ToolRegistry()
    registry.register(probe('bank:b'))
    registry.register(probe('bank:a'))

    expect(registry.names()).toEqual(['bank:b', 'bank:a'])
  })
})
