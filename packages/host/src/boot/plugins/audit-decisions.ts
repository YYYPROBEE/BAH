/**
 * base bundle · `audit:decisions`：会话级证据链（W08）。
 *
 * 为什么需要它：saga 链只记 `saga/*`（编排视角），**工具调用与治理判决不在链上**。
 * 本插件把一次会话里的三类证据写进 `<会话根>/<sessionId>/audit.jsonl`：
 *
 * | 条目 | 版本 | 来源 |
 * |---|---|---|
 * | `tool/call` | v1（历史形状） | `session/event` 的 `tool/call` |
 * | `sentry/decision` | v2 信封 | `safety:sentry` 的判决端口（不走会话事件） |
 * | `approval/decided` | v2 信封 | `session/event` 的 `approval/decided` |
 *
 * 纪律：
 * 1. **只增不改既有 `append` 调用点**：v2 走第 5 个可选参数（`persistence/chain`）；
 * 2. **不在本层伪造真相**：`tool/call` 直接从会话事件抄，`approval/decided` 同理；
 * 3. **断链即告警**：启动时扫全部链，断则 `audit/chain-broken` 平台事件 + stderr + HALT，
 *    没有关闭开关（W08 §1.3）；
 * 4. 版本化签名暂不启用（`signedTypes: []`）：演示/CI 无密钥也必须能起；
 *    哈希链保证"改一行会断"，完整验签仍由 `bah audit --key` 对既有白名单负责。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { defineService, type Context } from '@bah/core'
import { ChainFile, createSagaAudit } from '@bah/persistence'
import type { ChainDecision } from '@bah/persistence'
import { BahError, reasonOf } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { SESSION_FILES } from './persistence.ts'

/** 审批策略版本（与 `sentry-policy/2` 分开：两张判决面的规则来源不同）。 */
export const APPROVAL_POLICY_VERSION = 'approval-policy/1'

/** 一条待写链的判决（v2 信封字段由本层补齐）。 */
export interface DecisionChainEntry {
  readonly type: 'sentry/decision' | 'approval/decided'
  readonly data: unknown
  readonly subject: string
  readonly decision: ChainDecision
  readonly policyVersion: string
}

/** 一次断链发现（`brokenAt` 为 0 表示读取/解析失败，`error` 带理由）。 */
export interface ChainBreak {
  readonly chainId: string
  readonly brokenAt: number
  readonly error?: string
}

declare module '@bah/core' {
  interface BahEventMap {
    /**
     * 审计链断裂（W08 §1.3）。
     *
     * 平台告警事件，**不是会话事件**（事件表没有这个键）：持久告警由
     * `safety/halt(reason='chain-broken')` 承担，本事件只负责即时通知 sink。
     *
     * @mode emit
     */
    'audit/chain-broken': {
      readonly chainId: string
      /** 断裂条目序号（`0` = 文件读取/解析失败，见 stderr 的理由）。 */
      readonly brokenAt: number
      readonly at: number
    }
  }
}

/** 会话级证据链接缝（sentry 宿主行按它写 `sentry/decision`）。 */
export interface DecisionAudit {
  /** 写一条 v2 判决到当前会话链。 */
  append(entry: DecisionChainEntry): void
  /** 只验连续性（不读密钥）：启动时扫全部链。 */
  verifyAll(): readonly ChainBreak[]
}

/** 服务键：`audit:decisions`（宿主内部接缝；不跨包）。 */
export const DECISION_AUDIT = defineService<DecisionAudit>('audit:decisions')

/** 编排链的保留命名空间（`saga-<uuid>` 与 `system-startup`）。 */
const RESERVED_CHAIN_PREFIXES = ['saga-'] as const
const RESERVED_CHAIN_IDS = ['system-startup'] as const

/**
 * 当前会话的链 ID（与持久化目录同名，`bah audit --dir` 可直接发现）。
 *
 * **不得占用编排链命名空间**：`saga-*` / `system-startup` 已经属于 saga 链，
 * 若会话 ID 与之相同，两类条目会写进同一个 `audit.jsonl`，投影与断链定位都会失真。
 * 在 boot 期 fail-loud，而不是等到第一次工具调用。
 */
function sessionChainId(ctx: Context): string {
  const run = ctx.get(RUN_SERVICE)
  const id = String(run.sessionId)
  if (
    RESERVED_CHAIN_PREFIXES.some((prefix) => id.startsWith(prefix)) ||
    (RESERVED_CHAIN_IDS as readonly string[]).includes(id)
  ) {
    throw new BahError(
      'audit-chain-id-reserved',
      `bah-audit: audit-chain-id-reserved: 会话 ID ${id} 与编排链命名空间冲突（保留：saga-* / system-startup）；请换一个会话 ID`,
      { id },
    )
  }
  // 与 `ChainFile.assertSagaId` 同口径
  new ChainFile({ fsync: false, warn: () => {} }).pathOf(id)
  return id
}

/** 扫出根目录下所有含 `audit.jsonl` 的链（只一层，和 `ChainFile.readAll` 同口径）。 */
function chainIds(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'audit.jsonl')))
    .map((entry) => entry.name)
    .sort()
}

export const auditDecisionsPlugin: HostPlugin<Record<string, never>> = {
  id: 'audit:decisions',

  plugin: {
    name: 'audit:decisions',
    inject: [RUN_SERVICE.id, SESSION_FILES.id],
    apply(ctx) {
      const run = ctx.get(RUN_SERVICE)
      const root = resolve(ctx.get(SESSION_FILES).root)
      const chainId = sessionChainId(ctx)
      const audit = createSagaAudit({
        now: run.now,
        rootDir: root,
        // 决策链不引入密钥依赖：无密钥的演示/CI 也要能起；完整性由哈希链负责
        signedTypes: [],
        fsync: true,
        warn: (message) => console.warn(message),
      })

      ctx.effect(
        ctx.provide(DECISION_AUDIT, {
          append(entry) {
            audit.append(chainId, entry.type, entry.data, undefined, {
              subject: entry.subject,
              decision: entry.decision,
              policyVersion: entry.policyVersion,
            })
          },
          verifyAll() {
            const breaks: ChainBreak[] = []
            for (const id of chainIds(root)) {
              try {
                const result = audit.verifyContinuity(id)
                if (!result.ok) {
                  breaks.push({ chainId: id, brokenAt: result.brokenAt ?? 0 })
                }
              } catch (error) {
                breaks.push({ chainId: id, brokenAt: 0, error: reasonOf(error) })
              }
            }
            return breaks
          },
        }),
      )

      // 工具调用（含被拒绝的尝试）与审批结论：镜像会话事件，不另造真相
      ctx.effect(
        ctx.events.on('session/event', (envelope) => {
          const event = envelope.event
          if (event.type === 'tool/call') {
            audit.append(chainId, 'tool/call', event.data)
            return
          }
          if (event.type === 'approval/decided') {
            audit.append(chainId, 'approval/decided', event.data, undefined, {
              subject: `session:${chainId}`,
              // `allowed-once` 是唯一放行值；其余（rejected/cancelled/unavailable）一律 deny
              decision: event.data.decision === 'allowed-once' ? 'allow' : 'deny',
              policyVersion: APPROVAL_POLICY_VERSION,
            })
          }
        }),
      )
    },
  },

  validate() {
    return {}
  },
}
