/**
 * base bundle · `safety:verify`：断言核验门（W05）。
 *
 * 只做接线，判定全在 `@bah/safety` 的 `verify` 模块（纯函数）：
 * - 监听 `agent/reply`（waterfall），**先 `next()` 再判**——这样更内层的监听器
 *   （即使不调 `next()`）返回的文本也会被核验，无法"抢在内层改写后绕过核验"；
 * - 证据 = 本 turn 工具出参 + 提交给模型的运行时快照 + 系统当天日期。快照是权威
 *   银行数据（真模型会直接复述账户与余额），只认工具出参会把真话误判成「未核实」；
 * - 每次回复落一条 `safety/assertion`（四个计数自洽），供审计与 eval 读取；
 * - `reject` 时把文本替换为拒答，`needs-evidence` 时加 `【未核实】` 前缀。
 *
 * 装配顺序：本行应当是 `agent/reply` 的**最外层**监听器（先于其它回复改写插件装配）。
 * waterfall 的注册顺序 = 外层顺序，最外层先执行、也最后返回判决。
 */

import { verifyReply } from '@bah/safety'
import { SESSION_SERVICE } from '@bah/runtime'
import type { AgentReplyInput, SessionApi } from '@bah/runtime'
import type { ContentBlock } from '@bah/core'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { readBoolean, rejectUnknownKeys } from '../config.ts'
import { RUN_SERVICE } from '../boot.ts'

/** `safety:verify` 的配置。 */
export interface VerifySettings {
  /** `false` = 不装配监听器（回到"没有核验门"的旧行为；一行即可回滚）。 */
  readonly enabled: boolean
}

export const verifyPlugin: HostPlugin<VerifySettings> = {
  id: 'safety:verify',

  plugin: {
    name: 'safety:verify',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id],
    apply(ctx, config) {
      if (!config.enabled) return
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE) as SessionApi

      ctx.effect(
        ctx.events.on('agent/reply', async (input, next) => {
          const downstream = (await next(input)) as AgentReplyInput
          const outcome = verifyReply({
            text: downstream.text,
            evidence: [
              ...evidenceTexts(downstream.toolResults),
              ...(downstream.contextTexts ?? []),
              systemDateText(run.now()),
            ],
          })
          session.append(
            'safety/assertion',
            {
              turnId: `turn:${String(downstream.turn)}`,
              total: outcome.total,
              verified: outcome.verified,
              needsEvidence: outcome.needsEvidence,
              rejected: outcome.rejected,
              at: run.now(),
            },
            { ignorable: true },
          )
          if (outcome.decision === 'pass') return downstream
          return { ...downstream, text: outcome.text }
        }),
      )
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['enabled'], 'safety:verify')
    return { enabled: readBoolean(config, 'enabled', 'safety:verify', true) }
  },
}

/**
 * 当天日期作为证据。
 *
 * 模型在答「余额」时常用运行时快照的口径写「截至 2026-10-31」，而截止时间来自
 * 权威槽位快照、不是本 turn 的工具出参。只放**当天**这一条：其他日期仍需工具出参证明，
 * 写错日期照样落 `【未核实】`。
 */
function systemDateText(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `系统日期 ${String(date.getFullYear())}-${month}-${day}`
}

/** 工具出参 → 证据文本（只取成功结果的文本块；失败文案里的金额不是权威余额）。 */
function evidenceTexts(
  results: readonly {
    readonly isError: boolean
    readonly content: readonly ContentBlock[]
  }[],
): string[] {
  const texts: string[] = []
  for (const result of results) {
    if (result.isError) continue
    for (const block of result.content) {
      if (block.type === 'text' && block.text.trim().length > 0) texts.push(block.text)
    }
  }
  return texts
}
