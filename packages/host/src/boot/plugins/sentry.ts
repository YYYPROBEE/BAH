/**
 * base bundle · `safety:sentry`：安全防护层（施工单 10 批次 B）。
 *
 * 本行只做**接线**，判决与算法全在 `@bah/safety` 的 sentry 模块里：
 * - 四接缝：`agent/pre-step` / `tools/pre-execute` / `tools/result` / `session/event`；
 * - 幻觉防护：`tools/post-execute` + `agent/turn-stopping`；
 * - 外部世界端口：`TOOLS_SERVICE`（tier）、`BANK_TICKETS`（状态 + 批量吊销）、
 *   `AGENTS_SERVICE`（把纠正提示推回 next-step）、`SESSION_SERVICE`（durable 落账）。
 *
 * **装配顺序**：必须排在 `bank:tools` 之后（需要 `bank:tickets`），
 * 排在 `interaction:approval` 之后（waterfall 注册顺序 = 外层顺序：bank 先判三级，
 * sentry 只在允许路径上追加确定性拒绝）。
 */

import { BANK_TICKETS } from '@bah/bank'
import {
  SENTRY_SERVICE,
  provideSentry,
  resolveSentrySettings,
  type SentrySettings,
} from '@bah/safety'
import { AGENTS_SERVICE, SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import type { AgentId, SessionApi } from '@bah/runtime'
import type { TicketId } from '@bah/core'

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
      BANK_TICKETS.id,
    ],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)
      const tools = ctx.get(TOOLS_SERVICE)
      const agents = ctx.get(AGENTS_SERVICE)
      const tickets = ctx.get(BANK_TICKETS)

      // TraceLog 的落盘出口：`stderr` 时逐批写标准错误（不碰 fs；审计导出属施工单 12）
      const traceSink =
        config.trace.sink === 'stderr'
          ? (lines: readonly string[]): void => {
              process.stderr.write(`${lines.join('\n')}\n`)
            }
          : undefined

      const handle = provideSentry(ctx, config, {
        sessionId: run.sessionId,
        now: run.now,
        record: (type, data) => {
          appendIgnorable(session, type, data)
        },
        toolTier: (name) => {
          if (!tools.has(name)) return undefined
          const tier = tools.get(name).tier
          return {
            level: tier.level,
            ...(tier.amountPath === undefined ? {} : { amountPath: tier.amountPath }),
          }
        },
        ticketStatus: (ticketId) => tickets.status(ticketId as TicketId),
        revokeTickets: (reason, at) => tickets.revokeAll(reason, at).length,
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
    return resolveSentrySettings(config)
  },
}

/** 按领域键落账（`ignorable: true`；平台 reader 不认识治理族，施工单 10 硬约束 6）。 */
function appendIgnorable(session: SessionApi, type: string, data: unknown): void {
  const append = session.append as unknown as (
    type: string,
    data: unknown,
    options: { ignorable: boolean },
  ) => unknown
  append(type, data, { ignorable: true })
}
