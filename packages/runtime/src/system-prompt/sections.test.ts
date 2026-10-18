/**
 * 六段内建提示词单测（施工单 05 §4：能力位裁剪 + 工具 schema 自动汇入）。
 */

import { describe, expect, it } from 'vitest'

import { createDefaultPromptRegistry } from './index.ts'
import { formatMoney, renderRuntimeContext } from './sections.ts'
import type { ChannelKind, PromptContext, ToolDescriptor } from './types.ts'

const TRANSFER: ToolDescriptor = {
  name: 'transfer_money',
  description: '转账',
  schema: {
    type: 'object',
    properties: { amount: { type: 'number' }, payee: { type: 'string' } },
    required: ['amount'],
  },
  tier: { level: 'yellow', amountPath: 'amount' },
}

const QUERY_BILL: ToolDescriptor = {
  name: 'query_bill',
  description: '查账单',
  schema: { type: 'object' },
  tier: { level: 'green' },
}

function contextOf(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    capabilities: { toolCall: true, image: false, reasoning: false },
    tools: [TRANSFER, QUERY_BILL],
    channel: 'web',
    ...overrides,
  }
}

describe('能力位裁剪（施工单 05 §3 / §4）', () => {
  it('T-LLM-006 无 toolCall 能力 → bank.capabilities 不装配（也不装配审批段）', () => {
    const registry = createDefaultPromptRegistry()
    const composed = registry.compose(
      contextOf({ capabilities: { toolCall: false, image: false, reasoning: true } }),
    )

    expect(composed.sectionIds).not.toContain('bank.capabilities')
    expect(composed.sectionIds).not.toContain('policy.approval')
    expect(composed.header).not.toContain('可用工具')
    // 不依赖工具能力的段照常装配
    expect(composed.sectionIds).toEqual(['identity.safety', 'bank.domain', 'style'])
  })

  it('有 toolCall 但没注册工具 → 同样不装配能力段（发空清单只会诱导模型编工具名）', () => {
    const registry = createDefaultPromptRegistry()
    const composed = registry.compose(contextOf({ tools: [] }))

    expect(composed.sectionIds).not.toContain('bank.capabilities')
    expect(composed.sectionIds).not.toContain('policy.approval')
  })

  it('全是绿级工具 → 能力段装配、审批段不装配（讲审批规则等于噪音）', () => {
    const registry = createDefaultPromptRegistry()
    const composed = registry.compose(contextOf({ tools: [QUERY_BILL] }))

    expect(composed.sectionIds).toContain('bank.capabilities')
    expect(composed.sectionIds).not.toContain('policy.approval')
  })

  it('有黄/红级工具 → 审批段装配', () => {
    const registry = createDefaultPromptRegistry()
    const composed = registry.compose(contextOf())
    expect(composed.sectionIds).toContain('policy.approval')
    expect(composed.header).toContain('批准只对「当前参数 + 当前票据」生效一次')
  })
})

describe('bank.capabilities：工具 schema 自动汇入', () => {
  it('从 ToolDescriptor[] 现算：含权限级别与参数类型，必填打 *', () => {
    const registry = createDefaultPromptRegistry()
    const header = registry.compose(contextOf()).header

    expect(header).toContain('- transfer_money（yellow）：转账；参数 amount*: number，payee: string')
    expect(header).toContain('- query_bill（green）：查账单；参数 无')
  })

  it('参数没有 type 时标 any（不猜类型）', () => {
    const registry = createDefaultPromptRegistry()
    const header = registry.compose(
      contextOf({
        tools: [
          {
            name: 'raw',
            description: '原样透传',
            schema: { type: 'object', properties: { payload: { description: '任意结构' } } },
            tier: { level: 'green' },
          },
        ],
      }),
    ).header
    expect(header).toContain('payload: any')
  })
})

describe('renderRuntimeContext（施工单 05 §4.1 的渲染面）', () => {
  it('没有视图 / 空视图 → undefined（该段不装配）', () => {
    expect(renderRuntimeContext(undefined)).toBeUndefined()
    expect(renderRuntimeContext({})).toBeUndefined()
    expect(renderRuntimeContext({ user: {} })).toBeUndefined()
    expect(renderRuntimeContext({ accounts: [], recentTransactions: [], notes: [] })).toBeUndefined()
  })

  it('逐块渲染：当前用户 / 账户概览 / 最近交易 / 补充说明', () => {
    const text = renderRuntimeContext({
      user: { name: '张三', level: '金卡' },
      accounts: [{ name: '储蓄卡', maskedNumber: '1234', balance: 12345.6 }],
      recentTransactions: ['2026-10-01 超市 -88.00'],
      notes: ['本对话为演示数据'],
    })

    expect(text).toBe(
      [
        '【当前用户】姓名：张三；等级：金卡',
        '【账户概览】',
        '- 储蓄卡（尾号 1234）：余额 ¥12345.60',
        '【最近交易】',
        '- 2026-10-01 超市 -88.00',
        '【补充说明】',
        '- 本对话为演示数据',
      ].join('\n'),
    )
  })

  it('只给部分字段时只渲染对应块', () => {
    expect(renderRuntimeContext({ user: { name: '李四' } })).toBe('【当前用户】姓名：李四')
    expect(formatMoney(-12.5)).toBe('¥-12.50')
  })
})

describe('style：渠道适配', () => {
  it('六个渠道各有专属提示（穷尽 ChannelKind）', () => {
    const registry = createDefaultPromptRegistry()
    const channels: readonly ChannelKind[] = ['web', 'mobile', 'im', 'desktop', 'headless', 'sdk']

    for (const channel of channels) {
      const header = registry.compose(contextOf({ channel })).header
      expect(header).toContain('渠道适配：')
      expect(header).toContain(channelHint(channel))
    }
  })

  it('未指定渠道时按 headless 处理（缺省不抛错）', () => {
    const registry = createDefaultPromptRegistry()
    expect(registry.compose(contextOf({ channel: undefined })).header).toContain('无头：')
  })
})

describe('恒装配的两段：身份与领域', () => {
  it('identity.safety 含四条安全底线关键词；bank.domain 含三级权限', () => {
    const registry = createDefaultPromptRegistry()
    const header = registry.compose(contextOf()).header

    expect(header).toContain('不得编造账户、余额、交易')
    expect(header).toContain('涉及资金变动一律走工具')
    expect(header).toContain('拒绝越权')
    expect(header).toContain('三级权限：绿(green) 直接执行；黄(yellow) 需用户确认')
  })
})

/** 各渠道提示的片段（与实现同一份表述的表驱动断言）。 */
function channelHint(channel: ChannelKind): string {
  switch (channel) {
    case 'web':
      return '网页：'
    case 'mobile':
      return '移动 H5：'
    case 'im':
      return 'IM：'
    case 'desktop':
      return '桌面端：'
    case 'headless':
      return '无头：'
    case 'sdk':
      return 'SDK：'
  }
}
