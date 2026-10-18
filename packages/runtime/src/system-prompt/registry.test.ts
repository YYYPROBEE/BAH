/**
 * 提示词装配单测（施工单 05 §4）。
 */

import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { createDefaultPromptRegistry } from './index.ts'
import { PromptRegistry } from './registry.ts'
import { DEFAULT_SECTIONS } from './sections.ts'
import type { PromptContext, PromptSection, ToolDescriptor } from './types.ts'
import { SECTION_ORDERS } from './types.ts'

const TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'transfer_money',
    description: '转账',
    schema: {
      type: 'object',
      properties: { amount: { type: 'number' }, payee: { type: 'string' } },
      required: ['amount'],
    },
    tier: { level: 'yellow', amountPath: 'amount' },
  },
]

/** 六段全装配的基准上下文。 */
const CONTEXT: PromptContext = {
  capabilities: { toolCall: true, image: false, reasoning: false },
  tools: TOOLS,
  channel: 'web',
  runtime: {
    user: { name: '张三', level: '金卡' },
    accounts: [{ name: '储蓄卡', maskedNumber: '1234', balance: 12345.6 }],
    recentTransactions: ['2026-10-01 超市 -88.00'],
  },
}

describe('PromptRegistry（施工单 05 §4）', () => {
  it('T-LLM-007 section 顺序：六 section order 单调递增且与冻结表一致', () => {
    const orders = DEFAULT_SECTIONS.map((section) => section.order)
    expect(orders).toEqual([0, 10, 20, 30, 40, 50])
    for (let index = 1; index < orders.length; index += 1) {
      expect(orders[index]!).toBeGreaterThan(orders[index - 1]!)
    }

    // 冻结表与内建集合一一对应（改表 = 破坏性变更）
    expect(DEFAULT_SECTIONS.map((section) => section.id)).toEqual(Object.keys(SECTION_ORDERS))
    expect(SECTION_ORDERS['runtime.context']).toBe(30)
  })

  it('T-LLM-007 乱序注册也按 order 装配（装配顺序不依赖注册顺序）', () => {
    const registry = new PromptRegistry()
    // 反向注册：如果实现按注册顺序拼，这里立刻暴露
    for (const section of [...DEFAULT_SECTIONS].reverse()) registry.register(section)

    const composed = registry.compose(CONTEXT)
    expect(composed.parts.map((part) => part.order)).toEqual([0, 10, 20, 30, 40, 50])
    expect(composed.sectionIds).toEqual([
      'identity.safety',
      'bank.domain',
      'bank.capabilities',
      'runtime.context',
      'policy.approval',
      'style',
    ])

    // system 头里不能出现运行时上下文（施工单 05 §4.1）
    expect(composed.header).not.toContain('尾号 1234')
    expect(composed.context).toContain('尾号 1234')
  })

  it('注册即可逆：disposer 幂等，注销后可重新注册', () => {
    const registry = new PromptRegistry()
    const section: PromptSection = { id: 'extra', order: 5, render: () => '额外段' }

    const dispose = registry.register(section)
    expect(registry.has('extra')).toBe(true)
    expect(registry.ids()).toEqual(['extra'])

    dispose()
    dispose()
    expect(registry.has('extra')).toBe(false)
    expect(() => registry.get('extra')).toThrowError(BahError)

    registry.register(section)
    expect(registry.has('extra')).toBe(true)
    expect(registry.get('extra')).toBe(section)
  })

  it('空 id / 非法 order / 重名 都是 misconfiguration，载入即抛', () => {
    const registry = new PromptRegistry()
    expect(() => registry.register({ id: '', order: 0, render: () => 'x' })).toThrowError(
      /section id 不能为空/,
    )
    expect(() => registry.register({ id: 'a', order: -1, render: () => 'x' })).toThrowError(
      /order 必须是非负整数/,
    )
    expect(() => registry.register({ id: 'b', order: 1.5, render: () => 'x' })).toThrowError(
      /order 必须是非负整数/,
    )

    registry.register({ id: 'dup', order: 1, render: () => 'x' })
    expect(() => registry.register({ id: 'dup', order: 2, render: () => 'y' })).toThrowError(
      /section dup 已注册/,
    )
  })

  it('render 返回 undefined 或空白 → 该段不装配（能力位裁剪机制）', () => {
    const registry = new PromptRegistry()
    registry.register({ id: 'always', order: 0, render: () => 'always' })
    registry.register({ id: 'dropped', order: 10, render: () => undefined })
    registry.register({ id: 'blank', order: 20, render: () => '   ' })

    const composed = registry.compose({ capabilities: { toolCall: false, image: false, reasoning: false }, tools: [] })
    expect(composed.sectionIds).toEqual(['always'])
    expect(composed.header).toBe('always')
  })

  it('同 order 时保持注册顺序（稳定排序）', () => {
    const registry = new PromptRegistry()
    registry.register({ id: 'first', order: 10, render: () => '一' })
    registry.register({ id: 'second', order: 10, render: () => '二' })
    expect(registry.compose(CONTEXT).header).toBe('一\n\n二')
  })

  it('target=context 的段只进 context，不进 header；全空上下文不产出 context 字段', () => {
    const registry = new PromptRegistry()
    registry.register({ id: 'header', order: 0, render: () => '头' })
    registry.register({ id: 'body', order: 10, target: 'context', render: () => '身' })

    const composed = registry.compose(CONTEXT)
    expect(composed.header).toBe('头')
    expect(composed.context).toBe('身')
    expect(composed.parts.map((part) => part.id)).toEqual(['header', 'body'])

    const headerOnly = new PromptRegistry()
    headerOnly.register({ id: 'header', order: 0, render: () => '头' })
    expect(headerOnly.compose(CONTEXT).context).toBeUndefined()
  })

  it('默认注册表装了六段；未装运行时视图时 runtime.context 自动不装配', () => {
    const registry = createDefaultPromptRegistry()
    expect(registry.list()).toHaveLength(6)

    const withoutRuntime = registry.compose({ ...CONTEXT, runtime: undefined })
    expect(withoutRuntime.sectionIds).not.toContain('runtime.context')
    expect(withoutRuntime.context).toBeUndefined()
    expect(withoutRuntime.sectionIds).toHaveLength(5)
  })
})
