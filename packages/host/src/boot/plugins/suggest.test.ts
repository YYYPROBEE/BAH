/**
 * 追问建议的**解析与降级**（模型输出是不可信输入）。
 *
 * 判据分两层：
 * 1. `parseSuggestions`：编号 / 引号 / "建议：" 前缀都要能剥掉；压成一行的两条要能拆开；
 *    过短、过长、重复的不要；解析不出来给空数组（前端据此回退规则表）。
 * 2. `createSuggestService`：本地 provider（router/mock）没有生成能力 ⇒ 直接空数组；
 *    助手正文为空 ⇒ 不发请求；模型抛错 ⇒ 静默降级，绝不把主对话带红。
 */
import { describe, expect, it } from 'vitest'

import type { LlmAdapterRegistry } from '@bah/llm'

import { createSuggestService, parseSuggestions } from './suggest.ts'

/** 造一个只吐给定文本的假注册表；`fail` 时在任何一步抛错。 */
function registryOf(text: string, fail = false): LlmAdapterRegistry {
  const adapter = {
    prepareCall: async () => {
      if (fail) throw new Error('provider-down')
      return { id: 'call-1' }
    },
    stream: async function* () {
      if (fail) throw new Error('provider-down')
      yield { kind: 'text-delta' as const, text }
    },
  }
  return {
    resolve: () => ({ adapter }),
  } as unknown as LlmAdapterRegistry
}

describe('parseSuggestions：模型输出按不可信输入处理', () => {
  it('剥掉编号、顿号、引号与"建议："前缀', () => {
    expect(
      parseSuggestions('1. 查一下余额\n2、「冻结这张卡」\n- 建议：看看账单'),
    ).toEqual(['查一下余额', '冻结这张卡', '看看账单'].slice(0, 2))
  })

  it('两条压成一行时按编号拆开', () => {
    expect(parseSuggestions('1. 查余额 2. 转账')).toEqual(['查余额', '转账'])
  })

  it('空输入 / 全空白 ⇒ 空数组', () => {
    expect(parseSuggestions('')).toEqual([])
    expect(parseSuggestions('   \n  \n')).toEqual([])
  })

  it('过短（1 字）、过长（>40 字）与重复条目都不进', () => {
    const long = 'x'.repeat(41)
    expect(parseSuggestions(`好\n${long}\n查余额\n查余额`)).toEqual(['查余额'])
  })

  it('最多两条，顺序即模型顺序', () => {
    expect(parseSuggestions('甲甲\n乙乙\n丙丙')).toEqual(['甲甲', '乙乙'])
  })
})

describe('createSuggestService：不可用时静默降级', () => {
  it('router / mock 本地 provider 不发请求（它们不能生成新句子）', async () => {
    for (const modelId of ['router:demo', 'mock:script']) {
      const service = createSuggestService({ registry: registryOf('甲甲\n乙乙'), modelId })
      expect(await service.suggest({ user: '查余额', assistant: '余额 1298.00 元' })).toEqual([])
    }
  })

  it('助手正文为空 ⇒ 不发请求（没有上下文就别猜）', async () => {
    const service = createSuggestService({ registry: registryOf('甲甲\n乙乙'), modelId: 'deepseek-chat' })
    expect(await service.suggest({ user: '在吗', assistant: '   ' })).toEqual([])
  })

  it('正常回包 ⇒ 解析出两条', async () => {
    const service = createSuggestService({
      registry: registryOf('1. 查流水\n2. 看账单'),
      modelId: 'deepseek-chat',
    })
    expect(await service.suggest({ user: '查余额', assistant: '余额 1298.00 元' })).toEqual([
      '查流水',
      '看账单',
    ])
  })

  it('模型抛错 ⇒ 空数组，不把异常冒给调用方（建议是辅助件）', async () => {
    const service = createSuggestService({ registry: registryOf('', true), modelId: 'deepseek-chat' })
    expect(await service.suggest({ user: '查余额', assistant: '余额 1298.00 元' })).toEqual([])
  })

  it('超长上下文按 1500 字符截断后仍能出建议', async () => {
    const service = createSuggestService({
      registry: registryOf('查流水\n看账单'),
      modelId: 'deepseek-chat',
    })
    const huge = '长'.repeat(2000)
    expect(await service.suggest({ user: huge, assistant: huge })).toEqual(['查流水', '看账单'])
  })
})
