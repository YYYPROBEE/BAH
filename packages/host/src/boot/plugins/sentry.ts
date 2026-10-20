/**
 * base bundle · `safety:sentry`：安全防护层（施工单 10 批次 B）。
 *
 * 本行只做**接线**，判决与算法全在 `@bah/safety` 的 sentry 模块里：
 * - 四接缝：`agent/pre-step` / `tools/pre-execute` / `tools/result` / `session/event`；
 * - 幻觉防护：`tools/post-execute` + `agent/turn-stopping`；
 * - 外部世界端口：`TOOLS_SERVICE`（tier）、`BANK_TICKET_GUARD`（只读状态 + 批量吊销）、
 *   `AGENTS_SERVICE`（把纠正提示推回 next-step）、`SESSION_SERVICE`（durable 落账）。
 *
 * **装配顺序**：必须排在 `bank:tools` 之后（需要 `bank:ticket-guard`），
 * 排在 `interaction:approval` 之后（waterfall 注册顺序 = 外层顺序：bank 先判三级，
 * sentry 只在允许路径上追加确定性拒绝）。
 */

import { BANK_TICKET_GUARD } from '@bah/bank'
import {
  SENTRY_SERVICE,
  provideSentry,
  resolveSentrySettings,
  type SentrySettings,
  type TraceSink,
} from '@bah/safety'
import { AGENTS_SERVICE, SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import type { AgentId } from '@bah/runtime'
import type { TicketId } from '@bah/core'
import { BahError } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'

/** `safety:sentry` 的配置就是 sentry 模块的 `SentrySettings`（校验已内聚在安全包）。 */
export type SentryPluginSettings = SentrySettings

export const sentryPlugin: HostPlugin<SentryPluginSettings> = {
  id: 'safety:sentry',

  plugin: {
    name: 'safety:sentry',
    inject: [
      RUN_SERVICE.id,
      SESSION_SERVICE.id,
      TOOLS_SERVICE.id,
      AGENTS_SERVICE.id,
      BANK_TICKET_GUARD.id,
    ],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)
      const tools = ctx.get(TOOLS_SERVICE)
      const agents = ctx.get(AGENTS_SERVICE)
      const ticketGuard = ctx.get(BANK_TICKET_GUARD)

      // TraceLog 的落盘出口：`memory` = 只留内存环；`session` = 逐条落 durable 会话事件；
      // `stderr` 仅演示（不可回放，生产环境由 validate 拒绝）。
      let traceSink: TraceSink | undefined
      if (config.trace.sink === 'stderr') {
        traceSink = (lines) => {
          process.stderr.write(`${lines.join('\n')}\n`)
        }
      } else if (config.trace.sink === 'session') {
        traceSink = (lines) => {
          for (const line of lines) {
            session.appendDomain('sentry/trace', JSON.parse(line), { ignorable: true })
          }
        }
      }

      const handle = provideSentry(ctx, config, {
        sessionId: run.sessionId,
        now: run.now,
        record: (type, data) => {
          session.appendDomain(type, data, { ignorable: true })
        },
        toolTier: (name) => {
          if (!tools.has(name)) return undefined
          const tier = tools.get(name).tier
          return {
            level: tier.level,
            ...(tier.amountPath === undefined ? {} : { amountPath: tier.amountPath }),
          }
        },
        ticketStatus: (ticketId) => ticketGuard.status(ticketId as TicketId),
        revokeTickets: (reason, at) => ticketGuard.revokeAll(reason, at).length,
        nudge: (agentId, text) => {
          // 纠正提示走 `next-step` 车道 + `context` 来源：模型下一 step 可见，且不伪装成用户原话
          agents.get(agentId as AgentId).send(text, { source: 'context', target: 'next-step' })
        },
        ...(traceSink === undefined ? {} : { traceSink }),
      })

      ctx.effect(ctx.provide(SENTRY_SERVICE, handle))
    },
  },

  validate(config) {
    // 未知键 / 类型 / 越界 / 正则编译失败 → 载入即抛（消息带 `bah-sentry: ` 前缀）
    const settings = resolveSentrySettings(config)
    // 生产护栏：标准错误不落盘、不可回放，只允许演示/测试使用
    if (process.env['NODE_ENV'] === 'production' && settings.trace.sink === 'stderr') {
      throw new BahError(
        'sentry-insecure-trace-sink',
        'bah-sentry: 生产环境禁止 trace.sink=stderr（标准错误不落盘、不可回放）；请改用 session',
        { sink: settings.trace.sink },
      )
    }
    return settings
  },
}
