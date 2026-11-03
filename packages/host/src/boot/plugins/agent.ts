/**
 * base bundle · `core:agent`：主循环。
 *
 * 只做装配：会话服务 + 模型注册表 + 提示词/工具注册表 → 一个 `AgentLoop`，
 * 并把它登记进活体注册表（`runtime:agents`），宿主按键取用。
 *
 * `channel` 是**提示词语气/长度**的输入，不是"渠道代码分支"：
 * 渠道差异仍由 profile patch 表达，这里只是把值往装配器里传。
 */

import { LLM_ADAPTERS } from '@bah/llm'
import { HALT_SERVICE } from '@bah/safety'
import {
  AgentLoop,
  AgentRegistry,
  RUNTIME_CONTEXT_SOURCE,
  SESSION_SERVICE,
  provideAgents,
  resolveAgentLoopConfig,
} from '@bah/runtime'
import { BahError } from '@bah/util'

import type {
  AgentLoopConfig,
  ChannelKind,
  RuntimeContextAccountView,
  RuntimeContextSource,
  RuntimeContextView,
} from '@bah/runtime'
import type { HaltHandle } from '@bah/safety'
import type { ServiceKey } from '@bah/core'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import {
  asRecord,
  bootError,
  describeValue,
  readEnum,
  readRequiredString,
  readString,
  readStringArray,
  rejectUnknownKeys,
} from '../config.ts'
import { createRuntimeContextResolver } from '../runtime-context.ts'
import { createSuggestService, SUGGEST_SERVICE } from './suggest.ts'

/** 允许的渠道（与 runtime 的 `ChannelKind` 同源）。 */
const CHANNELS = ['web', 'mobile', 'im', 'desktop', 'headless', 'sdk'] as const

/** 实体槽位开关（`none` = 静态画像；`bank` = 每 step 现读核心）。 */
const SLOT_SOURCES = ['none', 'bank'] as const

/** 默认主循环配置（base 的默认 = 真实 provider；headless 用 patch 换成 mock）。 */
const DEFAULT_LOOP: AgentLoopConfig = {
  model: 'deepseek:deepseek-chat',
  maxSteps: 32,
  parallelReadTools: true,
}

/** `core:agent` 的配置。 */
export interface AgentSettings {
  readonly channel?: ChannelKind
  /** 固定的运行时上下文视图（每次 attempt 现渲染；缺省 = 不带上下文段）。 */
  readonly runtimeContext?: RuntimeContextView
  /**
   * 实体槽位开关：`none`（默认）= 只用静态画像；`bank` = 每 step 从
   * `runtime:context-source`（由 `bank:tools` 提供）现读权威核心。
   */
  readonly slots: { readonly source: 'none' | 'bank' }
  /** 透传给主循环的配置（`model` / `params` / `compaction` / `maxSteps`）。 */
  readonly loop: AgentLoopConfig
}

/** `ctx.get` 的最小读口（抽出来是为了单测"缺服务 vs 装配 bug"两条分支）。 */
export interface ServiceReader {
  get<T>(key: ServiceKey<T>): T
}

/**
 * 懒取运行时上下文端口。
 *
 * `service-missing` = 这一行没装（合法装配，返回 undefined）；其它异常是装配 bug，
 * 必须原样上抛——不许被当成"没装"。`ServiceRegistry.get` 目前只抛 `service-missing`，
 * 所以 rethrow 是对"将来 get 增加错误类型"的守卫，由假 ctx 单测覆盖。
 */
export function contextSourceOf(ctx: ServiceReader): RuntimeContextSource | undefined {
  try {
    return ctx.get(RUNTIME_CONTEXT_SOURCE)
  } catch (error) {
    if ((error as { code?: string }).code === 'service-missing') return undefined
    throw error
  }
}

export const agentPlugin: HostPlugin<AgentSettings> = {
  id: 'core:agent',

  plugin: {
    name: 'core:agent',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id, LLM_ADAPTERS.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const agents = new AgentRegistry()
      provideAgents(ctx, agents)

      /**
       * 新 turn 的 HALT 闸（W07 TC-01）。
       *
       * 惰性取服务：`core:agent` 在 base 里排在 `safety:sentry` **之前**，apply 期硬取
       * 会永远等不到；而没有 sentry 的 profile（最小装配）也不该起不来——那种装配没有
       * HALT 面，闸自然放行。
       */
      const beforeSend = (): void => {
        let halt: HaltHandle
        try {
          halt = ctx.get(HALT_SERVICE)
        } catch {
          return
        }
        if (!halt.halted) return
        throw new BahError(
          'safety-halted',
          'safety: 系统已进入 HALT，拒绝新的 turn（需人工 MFA 票据解除）',
          { reason: halt.reason },
        )
      }

      /**
       * 运行时上下文解析器（每 step 现取端口）。
       *
       * 为什么 `getSource` 懒取而不是 `inject`：base bundle 的 `core:agent` 不能被 bank 绑死
       * （没有 `bank:tools` 的 profile 也要能起），而且 `bank:tools` 排在它之前/之后都可能。
       * 缺端口时不是降级：配置说要用 bank、装配却没给，属装配错误，必须让 turn failed。
       */
      const resolver = createRuntimeContextResolver({
        ...(config.runtimeContext === undefined ? {} : { staticView: config.runtimeContext }),
        slots: config.slots,
        getSource: () => contextSourceOf(ctx),
      })

      const loop = new AgentLoop({
        ctx,
        session: ctx.get(SESSION_SERVICE),
        registry: ctx.get(LLM_ADAPTERS),
        config: config.loop,
        now: run.now,
        beforeSend,
        ...(run.mintTicketId === undefined ? {} : { mintTicketId: run.mintTicketId }),
        ...(config.channel === undefined ? {} : { channel: config.channel }),
        // 静态且没有画像时**不传** provider：少一次每 step 调用（旧行为零变化）
        ...(config.runtimeContext === undefined && config.slots.source === 'none'
          ? {}
          : { runtimeContext: resolver }),
      })

      ctx.provide(
        SUGGEST_SERVICE,
        createSuggestService({ registry: ctx.get(LLM_ADAPTERS), modelId: config.loop.model }),
      )

      ctx.effect(agents.register(loop))
      // 逆序执行：先关驱动器再摘注册表（否则宿主可能拿到已 dispose 的 agent）
      ctx.effect(() => loop.dispose('context-disposed'))
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['channel', 'runtimeContext', 'slots', 'loop'], 'core:agent')

    const channel = readEnum(config, 'channel', 'core:agent', CHANNELS)
    const loop =
      config['loop'] === undefined ? DEFAULT_LOOP : resolveAgentLoopConfig(config['loop'])

    const slotsRecord =
      config['slots'] === undefined ? {} : asRecord(config['slots'], 'core:agent.slots')
    rejectUnknownKeys(slotsRecord, ['source'], 'core:agent.slots')
    const source = readEnum(slotsRecord, 'source', 'core:agent.slots', SLOT_SOURCES) ?? 'none'

    const runtimeContext =
      config['runtimeContext'] === undefined
        ? undefined
        : readRuntimeContextView(config['runtimeContext'], 'core:agent.runtimeContext')

    // 两个真相源：bank 模式下静态画像不许再写账户/流水（运行期还有一层兜底）
    if (source === 'bank' && runtimeContext !== undefined) {
      if (runtimeContext.accounts !== undefined || runtimeContext.recentTransactions !== undefined) {
        throw bootError(
          'invalid-config',
          'core:agent: slots.source=bank 时不得再写静态 accounts / recentTransactions（两个真相源）',
          { where: 'core:agent.runtimeContext' },
        )
      }
    }

    return {
      loop,
      slots: { source },
      ...(channel === undefined ? {} : { channel }),
      ...(runtimeContext === undefined ? {} : { runtimeContext }),
    }
  },
}

/* ────────────────────────────────────────────────────────────────────────────
 * `runtimeContext` 的形状校验
 * ──────────────────────────────────────────────────────────────────────────── */

/** 账户槽位允许的键（`balance: number` 的旧形状会在这里被挡住）。 */
const ACCOUNT_VIEW_KEYS = [
  'name',
  'maskedNumber',
  'balanceText',
  'availableText',
  'statusText',
] as const

/**
 * 读静态画像（`core:agent.runtimeContext`）。
 *
 * 为什么现在要补形状校验：视图 v2 把 `balance: number` 换成了 `balanceText: string`。
 * 旧 profile 若还写 `balance`，以前会静默渲染 `undefined`；现在必须在 boot 期用明确错误挡住。
 * `meta` **禁止**写进 profile：它是运行时字段，写进来就等于伪造 `source=bank`、
 * 绕过 `slots.source` 开关（S1 复审 F5）。
 */
export function readRuntimeContextView(value: unknown, where: string): RuntimeContextView {
  const record = asRecord(value, where)
  rejectUnknownKeys(record, ['user', 'accounts', 'recentTransactions', 'notes'], where)

  const user =
    record['user'] === undefined ? undefined : readRuntimeContextUser(record['user'], `${where}.user`)
  const accounts =
    record['accounts'] === undefined
      ? undefined
      : readRuntimeContextAccounts(record['accounts'], `${where}.accounts`)
  const recentTransactions = readStringArray(record, 'recentTransactions', where)
  const notes = readStringArray(record, 'notes', where)

  return {
    ...(user === undefined ? {} : { user }),
    ...(accounts === undefined ? {} : { accounts }),
    ...(recentTransactions === undefined ? {} : { recentTransactions }),
    ...(notes === undefined ? {} : { notes }),
  }
}

/** 读画像里的 `user`（只有 `name` / `level` 两个展示字段）。 */
function readRuntimeContextUser(
  value: unknown,
  where: string,
): { readonly name?: string; readonly level?: string } {
  const record = asRecord(value, where)
  rejectUnknownKeys(record, ['name', 'level'], where)
  const name = readString(record, 'name', where)
  const level = readString(record, 'level', where)
  return {
    ...(name === undefined ? {} : { name }),
    ...(level === undefined ? {} : { level }),
  }
}

/** 读画像里的 `accounts`（数组；每项前四个字段必填）。 */
function readRuntimeContextAccounts(
  value: unknown,
  where: string,
): readonly RuntimeContextAccountView[] {
  if (!Array.isArray(value)) {
    throw bootError('invalid-config', `${where} 必须是数组（收到 ${describeValue(value)}）`, {
      where,
    })
  }
  return value.map((item, index) => readRuntimeContextAccount(item, `${where}[${String(index)}]`))
}

/** 读一个账户槽位（金额一律是边界格式化好的字符串；不接 `number`）。 */
function readRuntimeContextAccount(value: unknown, where: string): RuntimeContextAccountView {
  const record = asRecord(value, where)
  rejectUnknownKeys(record, ACCOUNT_VIEW_KEYS, where)
  const name = readRequiredString(record, 'name', where)
  const maskedNumber = readRequiredString(record, 'maskedNumber', where)
  const balanceText = readRequiredString(record, 'balanceText', where)
  const availableText = readRequiredString(record, 'availableText', where)
  const statusText = readString(record, 'statusText', where)
  return {
    name,
    maskedNumber,
    balanceText,
    availableText,
    ...(statusText === undefined ? {} : { statusText }),
  }
}
