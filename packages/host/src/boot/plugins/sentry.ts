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

import { randomUUID } from 'node:crypto'

import { BANK_TICKET_GUARD } from '@bah/bank'
import { APPROVAL_SERVICE } from '@bah/interaction'
import {
  HALT_SERVICE,
  SENTRY_POLICY_VERSION,
  SENTRY_SERVICE,
  provideSentry,
  resolveSentrySettings,
  type HaltEvent,
  type HaltTicket,
  type SentrySettings,
  type TraceSink,
} from '@bah/safety'
import { AGENTS_SERVICE, SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import type { AgentId, SessionApi } from '@bah/runtime'
import type { TicketId } from '@bah/core'
import type { HaltEventType, SafetySessionEventMap } from '@bah/safety'
import { BahError, assertNever, reasonOf } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { DECISION_AUDIT } from './audit-decisions.ts'
import { createHaltStore } from './halt-store.ts'
import { DEFAULT_ROOT, tenantRootOf } from './persistence.ts'
import { findSentryRules } from './policy.ts'
import { RUN_SERVICE } from '../boot.ts'

/** `safety:sentry` 的配置就是 sentry 模块的 `SentrySettings`（校验已内聚在安全包）。 */
export type SentryPluginSettings = SentrySettings

/**
 * `session.append` 在 `safety/*` 上的窄口。
 *
 * 平台 `SessionEventType` 是封闭联合（不含域外键），而事件表 v1.0.1 要求 `safety/*`
 * 走 `append` 才能被 `verify-session-events` 反向覆盖。运行时是同一个方法：
 * 第三个参数显式 `ignorable: true`，旧 reader 跳过它（宪法 §4「领域事件默认 ignorable」）。
 */
interface HaltAppend {
  append<K extends HaltEventType>(
    type: K,
    data: SafetySessionEventMap[K],
    options: { readonly ignorable: true },
  ): unknown
}

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
      DECISION_AUDIT.id,
    ],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE) as SessionApi & HaltAppend
      const tools = ctx.get(TOOLS_SERVICE)
      const agents = ctx.get(AGENTS_SERVICE)
      const ticketGuard = ctx.get(BANK_TICKET_GUARD)
      // 会话级证据链（W08）：`tool/call` / `approval/decided` 由该插件镜像；
      // 本行只写自己的判决 `sentry/decision`（走 chain，不走 session 事件）。
      const decisionAudit = ctx.get(DECISION_AUDIT)

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

      /**
       * `safety/*` 的 durable 出口（W07 纪律：**必须** `session.append`）。
       *
       * 逐个 case 写字面量，而不是 `session.append(event.type, …)`：`verify-session-events`
       * 门禁只认字面量事件名，动态名字会让两个键静默逃过声明检查。
       */
      const recordHalt = (event: HaltEvent): void => {
        switch (event.type) {
          case 'safety/halt':
            session.append('safety/halt', event.data, { ignorable: true })
            break
          case 'safety/unfreeze':
            session.append('safety/unfreeze', event.data, { ignorable: true })
            break
          default:
            // 封闭联合已穷尽；显式收尾满足 assert-never 门禁（新增 HALT 事件必须走这里）。
            // 运行期不可达：类型新增一个键时 `event.type` 才会走到这里。
            /* v8 ignore next */
            assertNever(event, 'halt-event')
        }
      }

      /**
       * 申请解除票据（W07 §2.3）：走**一次真实的 U 盾审批**，不自己签票。
       *
       * 没有审批服务 / 没有应答者（`responder: none` 且 web 未挂）时直接返回 `undefined`
       * = `halt-approval-rejected`，绝不降级成"无票据解除"。审批服务在发出 `allowed-once`
       * 之前已经强制校验挑战通过（`ApprovalService.handle` 的 `challenge-required` 分支），
       * 所以拿到 allowed-once 就等于 MFA 已通过。
       */
      const requestHaltTicket = async (): Promise<HaltTicket | undefined> => {
        let approvals
        try {
          approvals = ctx.get(APPROVAL_SERVICE)
        } catch {
          return undefined
        }
        // 没有应答者 = 没有人能完成 MFA：不签票（比等满 TTL 更早失败）
        if (approvals.responderCount === 0) return undefined

        const at = run.now()
        const callId = `safety-unfreeze:${String(run.sessionId)}:${String(at)}`
        const ticketId = (run.mintTicketId?.(callId) ?? randomUUID()) as TicketId
        const expiresAt = at + config.halt.ticketTtlSeconds * 1_000

        session.append('approval/asked', {
          ticketId,
          callId,
          name: 'safety_unfreeze',
          challenge: 'ushield',
        })
        const answered = await ctx.events.waterfall('approval/request', {
          ticket: { ticketId, fingerprint: `safety-unfreeze:${String(ticketId)}`, expiresAt },
          callId,
          name: 'safety_unfreeze',
          summary: { title: '解除 HALT（U 盾 MFA）', tier: 'red' },
          challenge: 'ushield',
          decision: { decision: 'unavailable' },
        })
        const decision = answered.decision
        session.append('approval/decided', {
          ticketId,
          decision: decision.decision,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          ...(decision.decision === 'allowed-once'
            ? {}
            : { code: `approval-${decision.decision}` }),
        })

        if (decision.decision !== 'allowed-once') return undefined
        return { ticketId, status: 'approved', expiresAt, mfa: true }
      }

      /**
       * 外置规则集（S5）：`rules.engine=bundle` 时**必须**拿到 `policy:rules` 的
       * `sentry.rules`；缺了就是装配错误，启动失败（不静默退回内核 13 条）。
       */
      const ruleSetView = config.rules.engine === 'bundle' ? findSentryRules(ctx) : undefined
      if (config.rules.engine === 'bundle' && ruleSetView === undefined) {
        throw new BahError(
          'sentry-rules-missing',
          'safety:sentry.rules.engine=bundle 但没有装配 policy:rules 的 sentry.rules（或它排在 safety:sentry 之后）',
          { where: 'safety:sentry.rules.engine' },
        )
      }
      if (ruleSetView !== undefined) {
        try {
          void ruleSetView.descriptor
        } catch (error) {
          throw new BahError(
            'sentry-rules-missing',
            'policy:rules.active 没有 sentry.rules（engine=bundle 却无规则集）',
            { cause: reasonOf(error) },
          )
        }
      }
      const rulesFor = (): { readonly version: string } | undefined =>
        ruleSetView?.rulesFor(String(run.sessionId))

      const handle = provideSentry(ctx, config, {
        sessionId: run.sessionId,
        now: run.now,
        ...(ruleSetView === undefined ? {} : { ruleSet: () => ruleSetView.rulesFor(String(run.sessionId)) }),
        // HALT 跨重启（C3）：租户根下的 `halt.json` 与会话 ID 无关——停机是**部署级**
        // 事实，换个会话 ID 不该绕过它；但它是**租户级**事实，别的租户的进程不该被它挡住
        // （两个租户共用一个 jsonlDir 时，共享一份 halt.json 就是跨租户 DoS）。
        // 固定 `fsync: true`：停机写入不在审批热路径上（一次停机只写一次），
        // 没有理由为了演示省这一次 fsync。
        haltPersistence: createHaltStore({
          root: tenantRootOf(run.jsonlDir ?? DEFAULT_ROOT, run.tenantId),
        }),
        record: (type, data) => {
          session.appendDomain(type, data, { ignorable: true })
        },
        recordHalt,
        requestHaltTicket,
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
        recordDecision: (decision) => {
          decisionAudit.append({
            type: 'sentry/decision',
            data: decision,
            subject: `session:${String(run.sessionId)}`,
            decision: decision.decision,
            policyVersion: rulesFor()?.version ?? SENTRY_POLICY_VERSION,
          })
        },
        ...(traceSink === undefined ? {} : { traceSink }),
      })

      ctx.effect(ctx.provide(SENTRY_SERVICE, handle))
      // 独立服务键：主循环 / plan / 管理路由只需"能不能执行"，不必拿整个 sentry 面
      ctx.effect(ctx.provide(HALT_SERVICE, handle.halt))

      /**
       * 链断裂告警（W08 §1.3）：启动时扫全部链，断一条就 HALT。
       *
       * 为什么在这里而不是 audit 插件里：只有本行同时拿得到 HALT 与证据链；
       * 且 `halt()` 需要 `recordHalt`（session.append）已经接好。
       * **没有关闭开关**——断链不允许"继续跑但记一笔"。
       */
      for (const broken of decisionAudit.verifyAll()) {
        const detail = `审计链断裂：${broken.chainId} 第 ${String(broken.brokenAt)} 条${
          broken.error === undefined ? '' : `（${broken.error}）`
        }`
        // 先落 HALT：告警出口（stderr / 事件订阅者）失败不能挡住停机。
        // `safety/halt.detail` 的冻结口径是 ≤200 字：超长时截断（完整理由在 stderr）。
        handle.halt.halt(
          'chain-broken',
          detail.length > 200 ? `${detail.slice(0, 197)}...` : detail,
        )
        process.stderr.write(`bah-audit: audit/chain-broken ${detail}\n`)
        // 告警是扇出，不是判决：任一订阅者抛错只记 stderr，不回滚 HALT、不阻断启动。
        ctx.events.emitIsolated(
          'audit/chain-broken',
          { chainId: broken.chainId, brokenAt: broken.brokenAt, at: run.now() },
          (error) => {
            process.stderr.write(
              `bah-audit: audit/chain-broken sink-failed: ${reasonOf(error)}\n`,
            )
          },
        )
      }
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
