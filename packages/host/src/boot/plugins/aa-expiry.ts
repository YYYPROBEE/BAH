/**
 * AA 到期收口 job（ADR-0017）：`aa-expire`。
 *
 * 只做三件事：向 core 要"已过期但还在 collecting 的组" → 为每个真正转为
 * `expired` 的参与人落一条 `aa/participant-updated` → 记住这一组已经收口过。
 *
 * 幂等有两层：
 * 1. **状态机**：收口后组不再是 `collecting`，下一次扫描自然跳过；
 * 2. **本 job 的 `settled` 账本**：同一个 tick 周期内的重入/并发只处理一组一次。
 *    账本在内存、不 durable——core 本身不重放 AA 组，进程重启后组不存在。
 *
 * 从 `bank-tools.ts` 抽出来是为了能单独测：插件装配太重，而"同一组只收口一次"
 * 是这一单最容易写错的一行。
 */

import type { AaSettlementResult, BankAudit } from '@bah/bank'

import { logJson } from './log.ts'

/** job 真正依赖的两件事（结构性类型：测试给一个假 core 即可）。 */
export interface AaExpiryDeps {
  readonly core: {
    expireAaGroups(at: number): Promise<readonly AaSettlementResult[]>
  }
  readonly audit: BankAudit
  readonly now: () => number
}

/** 可重入保护 + 组级幂等账本。 */
export interface AaExpiryJob {
  /** 扫一次；任何失败都只记日志，不向调用方抛（tick 是尽力而为）。 */
  run(): Promise<void>
  /** 仅供测试观察：已经收口过的组号。 */
  readonly settledGroups: ReadonlySet<string>
}

export function createAaExpiryJob(deps: AaExpiryDeps): AaExpiryJob {
  const settledGroups = new Set<string>()
  let running = false

  return {
    settledGroups,
    async run() {
      if (running) return
      running = true
      try {
        const settled = await deps.core.expireAaGroups(deps.now())
        for (const result of settled) {
          const groupId = String(result.group.id)
          if (settledGroups.has(groupId)) continue
          settledGroups.add(groupId)
          for (const participantIndex of result.affected) {
            deps.audit.append('aa/participant-updated', {
              groupId,
              participantIndex,
              from: 'pending',
              to: 'expired',
              at: result.at,
            })
          }
        }
      } catch (error) {
        logJson('error', 'host.aa-expire-failed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      } finally {
        running = false
      }
    },
  }
}
