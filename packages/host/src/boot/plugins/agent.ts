/**
 * base bundle · `core:agent`：主循环（施工单 04）。
 *
 * 只做装配：会话服务 + 模型注册表 + 提示词/工具注册表 → 一个 `AgentLoop`，
 * 并把它登记进活体注册表（`runtime:agents`），宿主按键取用。
 *
 * `channel` 是**提示词语气/长度**的输入（施工单 05 §4 的 `style` 段），不是"渠道代码分支"：
 * 渠道差异仍由 profile patch 表达，这里只是把值往装配器里传。
 */

import { LLM_ADAPTERS } from '@bah/llm'
import { HALT_SERVICE } from '@bah/safety'
import {
  AgentLoop,
  AgentRegistry,
  SESSION_SERVICE,
  provideAgents,
  resolveAgentLoopConfig,
} from '@bah/runtime'
import { BahError } from '@bah/util'

import type { AgentLoopConfig, ChannelKind, RuntimeContextView } from '@bah/runtime'
import type { HaltHandle } from '@bah/safety'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { asRecord, readEnum, rejectUnknownKeys } from '../config.ts'

/** 允许的渠道（与 runtime 的 `ChannelKind` 同源）。 */
const CHANNELS = ['web', 'mobile', 'im', 'desktop', 'headless', 'sdk'] as const

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
  /** 透传给主循环的配置（`model` / `params` / `compaction` / `maxSteps`）。 */
  readonly loop: AgentLoopConfig
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

      const loop = new AgentLoop({
        ctx,
        session: ctx.get(SESSION_SERVICE),
        registry: ctx.get(LLM_ADAPTERS),
        config: config.loop,
        now: run.now,
        beforeSend,
        ...(run.mintTicketId === undefined ? {} : { mintTicketId: run.mintTicketId }),
        ...(config.channel === undefined ? {} : { channel: config.channel }),
        ...(config.runtimeContext === undefined
          ? {}
          : { runtimeContext: () => config.runtimeContext }),
      })

      ctx.effect(agents.register(loop))
      // 逆序执行：先关驱动器再摘注册表（否则宿主可能拿到已 dispose 的 agent）
      ctx.effect(() => loop.dispose('context-disposed'))
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['channel', 'runtimeContext', 'loop'], 'core:agent')

    const channel = readEnum(config, 'channel', 'core:agent', CHANNELS)
    const loop =
      config['loop'] === undefined ? DEFAULT_LOOP : resolveAgentLoopConfig(config['loop'])
    const runtimeContext =
      config['runtimeContext'] === undefined
        ? undefined
        : (asRecord(config['runtimeContext'], 'core:agent.runtimeContext') as RuntimeContextView)

    return {
      loop,
      ...(channel === undefined ? {} : { channel }),
      ...(runtimeContext === undefined ? {} : { runtimeContext }),
    }
  },
}
