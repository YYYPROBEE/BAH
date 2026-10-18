/**
 * base bundle · `core:model`：模型适配层（施工单 05 §2）。
 *
 * 一行只装**一个 provider**：`provider: mock` 或 `provider: deepseek`。
 * headless profile 用 patch 把 base 的 deepseek 整块换成 mock —— 这就是"渠道差异用 patch 表达"，
 * 代码里没有任何 `if (profile === 'headless')`（施工单 06 硬约束 2）。
 *
 * 密钥只从环境变量读（施工单 05 硬约束 2：仓库任何文件不得出现硬编码 key）。
 */

import { describeThrown } from '@bah/core'
import { LlmAdapterRegistry, provideLlm } from '@bah/llm'
import { DeepSeekAdapter } from '@bah/llm/deepseek'
import { MockLlmAdapter, textStep, toolCallStep, type MockStep } from '@bah/llm/mock'

import type { LlmAdapter } from '@bah/llm'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import {
  asRecord,
  bootError,
  describeValue,
  readEnum,
  readPositiveInteger,
  readRequiredString,
  readString,
  rejectUnknownKeys,
} from '../config.ts'

/** 脚本里的一步：纯文本回复，或一次工具调用。 */
export type MockStepSettings =
  | {
      readonly text: string
      /** 结束原因（缺省 `stop`；`length` 用来演示 max-tokens 的粘性关闭）。 */
      readonly finish?: 'stop' | 'length' | 'tool-calls'
    }
  | {
      readonly tool: {
        readonly id: string
        readonly name: string
        readonly args: Readonly<Record<string, unknown>>
      }
    }

/** `core:model` 的配置。 */
export interface ModelSettings {
  readonly provider: 'mock' | 'deepseek'
  /** provider 侧的模型 id（不含 `provider:` 前缀）。 */
  readonly model: string
  readonly baseUrl?: string
  /** mock 的分片大小（字符数）。 */
  readonly chunkSize?: number
  /** mock 的脚本（按调用次序消费；只对 mock 有意义）。 */
  readonly script?: readonly MockStepSettings[]
}

/** 各 provider 的默认模型（不猜能力位：默认值只选各自最通用的对话模型）。 */
const DEFAULT_MODELS = { mock: 'mock-chat', deepseek: 'deepseek-chat' } as const

/** 只对 mock 有意义的键（写错 provider 时不许静默忽略）。 */
const MOCK_ONLY_KEYS = ['chunkSize', 'script'] as const

export const modelPlugin: HostPlugin<ModelSettings> = {
  id: 'core:model',

  plugin: {
    name: 'core:model',
    apply(ctx, config) {
      const registry = new LlmAdapterRegistry()
      provideLlm(ctx, registry)
      ctx.effect(registry.register(createAdapter(config)))

      // 载入即验：注册的模型必须真实存在（不让"模型名写错"拖到第一次请求才炸）
      const qualified = `${config.provider}:${config.model}`
      try {
        registry.resolve(qualified)
      } catch (error) {
        throw bootError(
          'unknown-model',
          `core:model 的模型 ${qualified} 不可用：${describeThrown(error)}`,
          { model: qualified, cause: error },
        )
      }
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['provider', 'model', 'baseUrl', ...MOCK_ONLY_KEYS], 'core:model')

    const provider = readEnum(config, 'provider', 'core:model', ['mock', 'deepseek'] as const) ?? 'mock'
    const model = readString(config, 'model', 'core:model') ?? DEFAULT_MODELS[provider]
    const baseUrl = readString(config, 'baseUrl', 'core:model')
    const chunkSize = readPositiveInteger(config, 'chunkSize', 'core:model')
    const script = readScript(config['script'], provider)

    if (provider !== 'mock') {
      const wrong = MOCK_ONLY_KEYS.filter((key) => config[key] !== undefined)
      if (wrong.length > 0) {
        throw bootError(
          'mock-only-config',
          `core:model 的 ${wrong.join(' / ')} 只对 provider=mock 有意义（当前 provider=${provider}）`,
          { provider, keys: wrong },
        )
      }
    } else if (script === undefined) {
      throw bootError(
        'mock-script-missing',
        'core:model 用 provider=mock 时必须写 script（mock 没有真实模型，回复只能来自脚本）',
        { provider },
      )
    }

    return {
      provider,
      model,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(chunkSize === undefined ? {} : { chunkSize }),
      ...(script === undefined ? {} : { script }),
    }
  },
}

/** 按配置造适配器（mock / deepseek 二选一）。 */
function createAdapter(config: ModelSettings): LlmAdapter {
  if (config.provider === 'mock') {
    return new MockLlmAdapter({
      script: { steps: (config.script ?? []).map(toMockStep) },
      ...(config.chunkSize === undefined ? {} : { chunkSize: config.chunkSize }),
    })
  }
  const apiKey = process.env['DEEPSEEK_API_KEY']
  return new DeepSeekAdapter({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
  })
}

/** 脚本项 → mock 的一步（`tool` 步骤缺省结束原因为 `tool-calls`）。 */
function toMockStep(step: MockStepSettings): MockStep {
  if ('text' in step) return textStep(step.text, step.finish ?? 'stop')
  return toolCallStep(step.tool.id, step.tool.name, step.tool.args)
}

/**
 * 读 mock 脚本。
 *
 * @throws `BahError('mock-only-script')` 给非 mock provider 写脚本
 * @throws `BahError('invalid-config')` 形状不对
 */
function readScript(
  value: unknown,
  provider: ModelSettings['provider'],
): readonly MockStepSettings[] | undefined {
  if (value === undefined) return undefined
  if (provider !== 'mock') {
    throw bootError(
      'mock-only-script',
      `core:model.script 只对 provider=mock 有意义（当前 provider=${provider}）；真实 provider 的回复不来自脚本`,
      { provider },
    )
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw bootError('invalid-config', `core:model.script 必须是非空数组（收到 ${describeValue(value)}）`)
  }
  return value.map((item, index) => readStep(item, `core:model.script[${index}]`))
}

/** 读脚本的一步（`text` / `tool` 二选一）。 */
function readStep(value: unknown, where: string): MockStepSettings {
  const record = asRecord(value, where)
  rejectUnknownKeys(record, ['text', 'tool', 'finish'], where)
  const hasText = record['text'] !== undefined
  const hasTool = record['tool'] !== undefined
  if (hasText === hasTool) {
    throw bootError('invalid-config', `${where} 必须且只能写 text 或 tool 之一`, { where })
  }
  if (hasText) {
    const finish = readEnum(record, 'finish', where, ['stop', 'length', 'tool-calls'] as const)
    return {
      text: readRequiredString(record, 'text', where),
      ...(finish === undefined ? {} : { finish }),
    }
  }

  const tool = asRecord(record['tool'], `${where}.tool`)
  rejectUnknownKeys(tool, ['id', 'name', 'args'], `${where}.tool`)
  return {
    tool: {
      id: readRequiredString(tool, 'id', `${where}.tool`),
      name: readRequiredString(tool, 'name', `${where}.tool`),
      args: tool['args'] === undefined ? {} : asRecord(tool['args'], `${where}.tool.args`),
    },
  }
}
