/**
 * base bundle · `core:model`：模型适配层（施工单 05 §2）。
 *
 * 一行只装**一个 provider**：`provider: mock` 或 `provider: deepseek`。
 * headless profile 用 patch 把 base 的 deepseek 整块换成 mock —— 这就是"渠道差异用 patch 表达"，
 * 代码里没有任何 `if (profile === 'headless')`（施工单 06 硬约束 2）。
 *
 * 密钥只从环境变量读（施工单 05 硬约束 2：仓库任何文件不得出现硬编码 key）。
 */

import { defineService, describeThrown } from '@bah/core'
import { LlmAdapterRegistry, provideLlm } from '@bah/llm'
import { DeepSeekAdapter, DEEPSEEK_MODELS } from '@bah/llm/deepseek'
import { createDemoRouter } from '@bah/llm/demo'
import {
  MockLlmAdapter,
  outcomeStep,
  textStep,
  toolCallStep,
  type MockStep,
  type MockToolOutcome,
} from '@bah/llm/mock'

import type { Context } from '@bah/core'
import type { LlmAdapter, ModelPricing } from '@bah/llm'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { logJson } from './log.ts'
import {
  asRecord,
  bootError,
  describeValue,
  readBoolean,
  readEnum,
  readPositiveInteger,
  readRequiredString,
  readString,
  rejectUnknownKeys,
} from '../config.ts'

/** 脚本里的一步：纯文本回复、一次工具调用，或按工具结局二选一的收尾。 */
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
  | {
      /** 条件收尾：成功出 `ok`，工具失败/被拒出 `failed`（`{reason}` 换成工具给的理由）。 */
      readonly outcome: {
        /** 绑定工具名（缺省 = 本 turn 最后一条工具结局）。 */
        readonly tool?: string
        readonly ok: string
        readonly failed: string
      }
    }

/** `core:model` 的配置。 */
export interface ModelSettings {
  /**
   * - `mock`：固定脚本出队（回放与用例）；
   * - `router`：**读消息现规划**（离线演示兜底，不会答非所问）；
   * - `deepseek`：真实模型（OpenAI 兼容协议，`baseUrl` 可指向任何兼容端点）。
   */
  readonly provider: 'mock' | 'router' | 'deepseek'
  /** provider 侧的模型 id（不含 `provider:` 前缀）。 */
  readonly model: string
  readonly baseUrl?: string
  /** mock 的分片大小（字符数）。 */
  readonly chunkSize?: number
  /** mock 的脚本（按调用次序消费；只对 mock 有意义）。 */
  readonly script?: readonly MockStepSettings[]
  /** 密钥所在的环境变量名（默认 `DEEPSEEK_API_KEY`；随部署变化，不写死在代码里）。 */
  readonly apiKeyEnv?: string
  /**
   * 自定义模型的规格（只在模型不在内置表里时需要）。
   *
   * 为什么要有：`deepseek` 适配器实现的是 **OpenAI 兼容协议**，可以指向任何兼容端点
   * （DashScope / 自建网关 / vLLM）。但内置模型表只有 DeepSeek 官方两个模型，
   * 换个端点就会报"不认识模型"。这里让部署方**显式声明**能力位，
   * 而不是由代码猜——猜错会连带裁错提示词段（工具段、推理段）。
   */
  readonly modelSpec?: {
    readonly displayName?: string
    readonly contextWindow?: number
    /** 是否支持 function calling（缺省 true；关掉会裁掉工具段）。 */
    readonly toolCall?: boolean
    readonly reasoning?: boolean
    readonly image?: boolean
  }
  /** 单次请求硬上限（ms；默认 120s）——上游挂起时绝不无限等待。 */
  readonly requestTimeoutMs?: number
  /**
   * 计价（D2）：每百万 token 的**微元**单价。
   *
   * 不写就等于"不记价"：`usage/summary.costMicroYuan` 恒为 0，成本看板看不出东西。
   * 写了就必须是部署方自己核过的价——仓库里不硬编码任何官方报价（会过期，也会被当成账单）。
   */
  readonly pricing?: ModelPricing
  /** 429 / 5xx 的同模型重试次数（默认 2）。 */
  readonly retryMax?: number
  /** 首次退避基数（ms；默认 300）。 */
  readonly retryBaseMs?: number
}

/** 各 provider 的默认模型（不猜能力位：默认值只选各自最通用的对话模型）。 */
const DEFAULT_MODELS = {
  mock: 'mock-chat',
  router: 'router-chat',
  deepseek: 'deepseek-chat',
} as const

/** 只对「本地生成」provider（mock / router）有意义的键。 */
const LOCAL_KEYS = ['chunkSize'] as const

/** 只对 mock（固定脚本）有意义的键：`router` 的步骤由请求现算，不读脚本。 */
const SCRIPT_ONLY_KEYS = ['script'] as const

/**
 * 计价是否已配置（可观测性 02 / N3）。
 *
 * 单独一个服务键而不是让 web 去读 `core:model` 的原始配置：profiles 用 patch 改写
 * `core:model` 的整块，读原始层会得到"被覆盖前的值"；服务由模型插件按**生效配置**提供。
 */
export const MODEL_PRICING = defineService<{ readonly configured: boolean }>('bah:model-pricing')

export const modelPlugin: HostPlugin<ModelSettings> = {
  id: 'core:model',

  plugin: {
    name: 'core:model',
    apply(ctx, config) {
      const registry = new LlmAdapterRegistry()
      provideLlm(ctx, registry)
      ctx.provide(MODEL_PRICING, { configured: config.pricing !== undefined })
      ctx.effect(registry.register(createAdapter(config, observeToolOutcomes(ctx, config))))

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
    rejectUnknownKeys(
      config,
      [
        'provider',
        'model',
        'baseUrl',
        'apiKeyEnv',
        'requestTimeoutMs',
        'retryMax',
        'retryBaseMs',
        'modelSpec',
        'pricing',
        ...LOCAL_KEYS,
        ...SCRIPT_ONLY_KEYS,
      ],
      'core:model',
    )

    const provider =
      readEnum(config, 'provider', 'core:model', ['mock', 'router', 'deepseek'] as const) ?? 'mock'
    const model = readString(config, 'model', 'core:model') ?? DEFAULT_MODELS[provider]
    const baseUrl = readString(config, 'baseUrl', 'core:model')
    const chunkSize = readPositiveInteger(config, 'chunkSize', 'core:model')
    const script = readScript(config['script'], provider)
    const apiKeyEnv = readString(config, 'apiKeyEnv', 'core:model')
    const requestTimeoutMs = readPositiveInteger(config, 'requestTimeoutMs', 'core:model')
    const retryMax = readPositiveInteger(config, 'retryMax', 'core:model')
    const retryBaseMs = readPositiveInteger(config, 'retryBaseMs', 'core:model')
    const modelSpec = readModelSpec(config['modelSpec'])
    const pricing = readPricing(config['pricing'])

    if (provider !== 'deepseek') {
      const wrong = [
        'apiKeyEnv',
        'requestTimeoutMs',
        'retryMax',
        'retryBaseMs',
        'baseUrl',
        'modelSpec',
        'pricing',
      ].filter((key) => config[key] !== undefined)
      if (wrong.length > 0) {
        throw bootError(
          'mock-only-config',
          `core:model 的 ${wrong.join(' / ')} 只对 provider=deepseek 有意义（当前 provider=${provider}）`,
          { provider, keys: wrong },
        )
      }
    }

    if (provider === 'deepseek') {
      const wrong = [...LOCAL_KEYS, ...SCRIPT_ONLY_KEYS].filter((key) => config[key] !== undefined)
      if (wrong.length > 0) {
        throw bootError(
          'local-only-config',
          `core:model 的 ${wrong.join(' / ')} 只对 provider=mock / router 有意义（当前 provider=deepseek）`,
          { provider, keys: wrong },
        )
      }
    } else if (provider === 'mock' && script === undefined) {
      throw bootError(
        'mock-script-missing',
        'core:model 用 provider=mock 时必须写 script（mock 没有真实模型，回复只能来自脚本）；' +
          '不想写脚本就用 provider=router（按消息现规划步骤）',
        { provider },
      )
    }

    return {
      provider,
      model,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(chunkSize === undefined ? {} : { chunkSize }),
      ...(script === undefined ? {} : { script }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(retryMax === undefined ? {} : { retryMax }),
      ...(retryBaseMs === undefined ? {} : { retryBaseMs }),
      ...(modelSpec === undefined ? {} : { modelSpec }),
      ...(pricing === undefined ? {} : { pricing }),
    }
  },
}

/**
 * 读计价（只对 deepseek 有意义）。
 *
 * 单价是**微元/百万 token**，用整数：金额一律不碰浮点（宪法 R-5 的同一条理由，
 * 虽然单价不直接参与扣款，但乘出来的 `costMicroYuan` 会进审计）。
 */
function readPricing(value: unknown): ModelPricing | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value, 'core:model.pricing')
  rejectUnknownKeys(record, ['inputPerMTok', 'cachedInputPerMTok', 'outputPerMTok'], 'core:model.pricing')

  const readRate = (key: string): number | undefined => {
    const raw = record[key]
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw bootError(
        'invalid-config',
        `core:model.pricing.${key} 必须是非负整数（微元/百万 token，收到 ${describeValue(raw)}）`,
        { key, value: raw },
      )
    }
    return raw
  }

  const inputPerMTok = readRate('inputPerMTok')
  const outputPerMTok = readRate('outputPerMTok')
  const cachedInputPerMTok = readRate('cachedInputPerMTok')
  if (inputPerMTok === undefined || outputPerMTok === undefined) {
    throw bootError(
      'invalid-config',
      'core:model.pricing 必须同时写 inputPerMTok 与 outputPerMTok（只写一半会让成本算成半个数）',
      { keys: Object.keys(record) },
    )
  }
  return {
    inputPerMTok,
    outputPerMTok,
    ...(cachedInputPerMTok === undefined ? {} : { cachedInputPerMTok }),
  }
}

/** 读自定义模型规格（只对 deepseek 有意义；形状不对直接拒绝）。 */
function readModelSpec(value: unknown): ModelSettings['modelSpec'] {
  if (value === undefined) return undefined
  const record = asRecord(value, 'core:model.modelSpec')
  rejectUnknownKeys(
    record,
    ['displayName', 'contextWindow', 'toolCall', 'reasoning', 'image'],
    'core:model.modelSpec',
  )
  const displayName = readString(record, 'displayName', 'core:model.modelSpec')
  const contextWindow = readPositiveInteger(record, 'contextWindow', 'core:model.modelSpec')
  // `readBoolean` 需要 fallback：只在该键存在时才读，未写就是"未声明"
  const flag = (key: string, fallback: boolean): boolean | undefined =>
    record[key] === undefined ? undefined : readBoolean(record, key, 'core:model.modelSpec', fallback)
  const toolCall = flag('toolCall', true)
  const reasoning = flag('reasoning', false)
  const image = flag('image', false)
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(toolCall === undefined ? {} : { toolCall }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(image === undefined ? {} : { image }),
  }
}

/** 按配置造适配器（mock / router / deepseek 三选一）。 */
function createAdapter(
  config: ModelSettings,
  toolOutcomes: (() => readonly MockToolOutcome[]) | undefined,
): LlmAdapter {
  if (config.provider === 'mock') {
    return new MockLlmAdapter({
      script: { steps: (config.script ?? []).map(toMockStep) },
      ...(config.chunkSize === undefined ? {} : { chunkSize: config.chunkSize }),
      ...(toolOutcomes === undefined ? {} : { toolOutcomes }),
    })
  }
  if (config.provider === 'router') {
    // 与 mock 共用同一个适配器实现，只是步骤由请求现算（读 messages，不看游标）
    return createDemoRouter({
      ...(config.chunkSize === undefined ? {} : { chunkSize: config.chunkSize }),
      ...(toolOutcomes === undefined ? {} : { toolOutcomes }),
    })
  }
  // 密钥来源名是配置项：换 vault / 网关注入时不需要改代码
  const apiKey = process.env[config.apiKeyEnv ?? 'DEEPSEEK_API_KEY']
  // 声明了 modelSpec 就只用它：指向非 DeepSeek 端点时，内置表里的 id 一定对不上
  const declared =
    config.modelSpec === undefined
      ? undefined
      : [
          {
            id: config.model,
            providerId: config.provider,
            displayName: config.modelSpec.displayName ?? config.model,
            capabilities: {
              toolCall: config.modelSpec.toolCall ?? true,
              image: config.modelSpec.image ?? false,
              reasoning: config.modelSpec.reasoning ?? false,
            },
            contextWindow: config.modelSpec.contextWindow ?? 32_000,
          },
        ]
  // D2：计价挂在**模型条目**上（适配器从 `call.model.pricing` 读）。
  // 没声明 modelSpec 时用内置表打补丁——这样内置模型也能记价，不必为了记价编一份 modelSpec。
  const models =
    config.pricing === undefined
      ? declared
      : (declared ?? DEEPSEEK_MODELS).map((model) =>
          model.id === config.model ? { ...model, pricing: config.pricing } : model,
        )
  return new DeepSeekAdapter({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: config.requestTimeoutMs }),
    ...(config.retryMax === undefined ? {} : { retryMax: config.retryMax }),
    ...(config.retryBaseMs === undefined ? {} : { retryBaseMs: config.retryBaseMs }),
    // 重试不能静默：一次 429 退避要能在演示现场 stderr 里看到
    onRetry: (info) =>
      logJson('warn', 'model-retry', {
        status: info.status,
        attempt: info.attempt,
        delayMs: info.delayMs,
      }),
    ...(models === undefined ? {} : { models }),
  })
}

/**
 * 给本地 provider（mock / router）的条件收尾步供一个"本会话见过的工具结局"读口。
 *
 * 只订阅不改写（`session/event` 是 emit 语义，落账方是 session service），注册即可逆。
 * 真实模型不订阅：它的收尾文案由模型自己看着工具结果写，不该由本进程代劳。
 */
function observeToolOutcomes(
  ctx: Context,
  config: ModelSettings,
): (() => readonly MockToolOutcome[]) | undefined {
  // 真实模型不订阅，也不给它造一个"永远读不到东西"的假读口：
  // 那样既没人调用（白占一个闭包），又会在类型上假装"deepseek 也有工具结局视图"。
  if (config.provider === 'deepseek') return undefined

  const outcomes: MockToolOutcome[] = []
  ctx.effect(
    ctx.events.on('session/event', (envelope) => {
      const event = envelope.event
      if (event.type !== 'tool/result') return
      const { name, isError, code, reason, content } = event.data
      outcomes.push({
        name,
        isError,
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
        ...(firstTextOf(content) === undefined ? {} : { text: firstTextOf(content)! }),
      })
    }),
  )
  return () => outcomes
}

/** 工具结果里的第一段正文（复述步用它把权威数字说回给人）。 */
function firstTextOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] !== 'text') continue
    const text = record['text']
    if (typeof text === 'string' && text.trim().length > 0) return text
  }
  return undefined
}

/** 脚本项 → mock 的一步（`tool` 步骤缺省结束原因为 `tool-calls`）。 */
function toMockStep(step: MockStepSettings): MockStep {
  if ('text' in step) return textStep(step.text, step.finish ?? 'stop')
  if ('tool' in step) return toolCallStep(step.tool.id, step.tool.name, step.tool.args)
  return outcomeStep({
    ok: step.outcome.ok,
    failed: step.outcome.failed,
    ...(step.outcome.tool === undefined ? {} : { tool: step.outcome.tool }),
  })
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

/** 读脚本的一步（`text` / `tool` / `outcome` 三选一）。 */
function readStep(value: unknown, where: string): MockStepSettings {
  const record = asRecord(value, where)
  rejectUnknownKeys(record, ['text', 'tool', 'outcome', 'finish'], where)
  const chosen = ['text', 'tool', 'outcome'].filter((key) => record[key] !== undefined)
  if (chosen.length !== 1) {
    throw bootError(
      'invalid-config',
      `${where} 必须且只能写 text / tool / outcome 之一（收到 ${chosen.length === 0 ? '都没有' : chosen.join(' + ')}）`,
      { where },
    )
  }
  if (chosen[0] !== 'text' && record['finish'] !== undefined) {
    throw bootError('invalid-config', `${where}.finish 只对 text 步有意义（当前是 ${chosen[0]} 步）`, { where })
  }
  if (chosen[0] === 'text') {
    const finish = readEnum(record, 'finish', where, ['stop', 'length', 'tool-calls'] as const)
    return {
      text: readRequiredString(record, 'text', where),
      ...(finish === undefined ? {} : { finish }),
    }
  }

  if (chosen[0] === 'tool') {
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

  const outcome = asRecord(record['outcome'], `${where}.outcome`)
  rejectUnknownKeys(outcome, ['tool', 'ok', 'failed'], `${where}.outcome`)
  return {
    outcome: {
      ok: readRequiredString(outcome, 'ok', `${where}.outcome`),
      failed: readRequiredString(outcome, 'failed', `${where}.outcome`),
      ...(outcome['tool'] === undefined
        ? {}
        : { tool: readRequiredString(outcome, 'tool', `${where}.outcome`) }),
    },
  }
}
