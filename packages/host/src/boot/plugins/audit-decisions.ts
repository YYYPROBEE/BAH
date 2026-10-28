/**
 * base bundle · `audit:decisions`：会话级证据链（W08 / B4）。
 *
 * 为什么需要它：saga 链只记 `saga/*`（编排视角），**工具调用与治理判决不在链上**。
 * 本插件把一次会话里的四类证据写进 `<会话根>/<sessionId>/audit.jsonl`：
 *
 * | 条目 | 版本 | 来源 |
 * |---|---|---|
 * | `tool/call` | v1（历史形状） | `session/event` 的 `tool/call` |
 * | `tool/result` | v1 摘要（B4） | `session/event` 的 `tool/result`，只存 `{callId,name,isError,code,durationMs}` |
 * | `sentry/decision` | v2 信封 | `safety:sentry` 的判决端口（不走会话事件） |
 * | `approval/decided` | v2 信封 | `session/event` 的 `approval/decided` |
 *
 * 纪律：
 * 1. **只增不改既有 `append` 调用点**：v2 走第 5 个可选参数（`persistence/chain`）；
 * 2. **不在本层伪造真相**：`tool/call` 直接从会话事件抄，`approval/decided` 同理；
 *    `tool/result` 只存摘要（`toolResultSummaryOf`），不写 content/reason（PII/体积）；
 * 3. **断链即告警**：启动时扫全部链，断则 `audit/chain-broken` 平台事件 + stderr + HALT，
 *    没有关闭开关（W08 §1.3）；
 * 4. **签名（B4）**：`signingKeyPath` 指向的私钥文件存在 → 对白名单类型签名
 *    （含 `tool/call` / `tool/result` / `approval/decided` / `sentry/decision`）；
 *    不存在 → 空集（unsigned），只 stderr 提示一次，**不阻断启动**。
 *    哈希链保证"改一行会断"；完整验签仍由 `bah audit --key` 负责。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { defineService, type Context } from '@bah/core'
import type { BankSessionEventMap } from '@bah/bank'
import { ChainFile, SIGNED_TYPES, createSagaAudit, toolResultSummaryOf } from '@bah/persistence'
import type { ChainDecision } from '@bah/persistence'
import { BahError, reasonOf } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { rejectUnknownKeys } from '../config.ts'
import { SESSION_FILES } from './persistence.ts'

/** 审批策略版本（与 `sentry-policy/2` 分开：两张判决面的规则来源不同）。 */
export const APPROVAL_POLICY_VERSION = 'approval-policy/1'

/** 缺省私钥路径（与 `bank:saga-audit` 同源；演示/CI 通常不存在）。 */
const DEFAULT_SIGNING_KEY_PATH = 'keys/saga-ed25519.pem'

/** 会话链上实际出现的、白名单允许签名的类型（`SIGNED_TYPES` 的全量子集）。 */
const SESSION_SIGNED_TYPES = [...SIGNED_TYPES]

/** `audit:decisions` 的配置（B4）。 */
export interface AuditDecisionsSettings {
  /**
   * Ed25519 私钥路径；存在则对白名单类型签名，不存在则 unsigned 启动（不失败）。
   * 缺省 `keys/saga-ed25519.pem`，与 `bank:saga-audit` 同源。
   */
  readonly signingKeyPath: string
}

/** 一条待写链的判决（v2 信封字段由本层补齐）。 */
export interface DecisionChainEntry {
  readonly type: 'sentry/decision' | 'approval/decided' | 'policy/decision'
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
  new ChainFile({ fsync: false }).pathOf(id)
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

export const auditDecisionsPlugin: HostPlugin<AuditDecisionsSettings> = {
  id: 'audit:decisions',

  plugin: {
    name: 'audit:decisions',
    inject: [RUN_SERVICE.id, SESSION_FILES.id],
    apply(ctx, settings) {
      const run = ctx.get(RUN_SERVICE)
      const root = resolve(ctx.get(SESSION_FILES).root)
      const chainId = sessionChainId(ctx)
      // B4：密钥存在才开签名；缺钥的演示/CI 照常起（unsigned），但要说出来，不能静默。
      //
      // `probe === false`（CLI `--dump-config`）时不告警：dump 是"只看不跑"，
      // 它的 stderr 是**契约**（A8 要求严格为空）。密钥探测本身没有副作用，
      // 但告警会污染"配置是否能载入"这条判据——真实的启动路径仍然会说。
      const keyExists = existsSync(resolve(settings.signingKeyPath))
      if (!keyExists && run.probe !== false) {
        console.warn(
          `[audit:decisions] 未找到签名私钥 ${settings.signingKeyPath}；` +
            '会话链以 unsigned 模式运行（哈希链仍保证连续性，验签需私钥 + `bah audit --key`）',
        )
      }
      const audit = createSagaAudit({
        now: run.now,
        rootDir: root,
        // 租户在建链时给一次：四类 append（tool/call、tool/result、sentry/decision、
        // approval/decided）因此全部带租户，不存在"漏传一处"的可能（TA-15）
        tenant: String(run.tenantId),
        // 密钥在 boot 期判定：存在 → 对白名单全量签名；缺钥 → 空集（unsigned）
        signedTypes: keyExists ? SESSION_SIGNED_TYPES : [],
        ...(keyExists ? { signingKeyPath: settings.signingKeyPath } : {}),
        fsync: false,
        warn: console.warn,
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
            const tenant = String(run.tenantId)
            const files = new ChainFile({ rootDir: root, fsync: false, warn: () => undefined })
            for (const id of chainIds(root)) {
              try {
                const result = audit.verifyContinuity(id)
                if (!result.ok) {
                  breaks.push({ chainId: id, brokenAt: result.brokenAt ?? 0 })
                  continue
                }
                /**
                 * 租户对账（复审 AR-02）：整目录被搬到别的租户下时，哈希链**仍然连续**，
                 * 只有这一条能发现。历史行没有 `tenant`，跳过（迁移前的链只能靠目录位置）。
                 */
                const foreign = files
                  .read(id)
                  .find((row) => row.tenant !== undefined && row.tenant !== tenant)
                if (foreign !== undefined) {
                  breaks.push({
                    chainId: id,
                    brokenAt: foreign.q,
                    error: `链行租户 ${String(foreign.tenant)} ≠ 本进程租户 ${tenant}（链目录可能被搬错租户）`,
                  })
                }
              } catch (error) {
                breaks.push({ chainId: id, brokenAt: 0, error: reasonOf(error) })
              }
            }
            return breaks
          },
        }),
      )

      // 工具调用（含被拒绝的尝试）、结果摘要与审批结论：镜像会话事件，不另造真相
      ctx.effect(
        ctx.events.on('session/event', (envelope) => {
          const event = envelope.event
          if (String(event.type) === 'tier/decided') {
            const data = event.data as unknown as BankSessionEventMap['tier/decided']
            /**
             * 策略判决入链（策略外置 S3 / 02 §4.4）。
             *
             * 链行只存 `d = sha256(canonicalJson(event.data))`；载荷本身在 session.jsonl。
             * 写失败**不改判**（I17）：这是证据链的旁路，不能把一次已做出的 allow/ask/deny
             * 翻转成错误——失败只告警，`policy:explain` 会显示 `chain: missing`。
             */
            try {
              audit.append(chainId, 'policy/decision', data, undefined, {
                subject: `session:${chainId}`,
                decision: data.verdict,
                policyVersion: data.policyVersion ?? 'legacy',
              })
            } catch (error) {
              console.warn(
                `[audit:decisions] policy/decision 写入失败（判决不变）：${reasonOf(error)}`,
              )
            }
            return
          }
          if (event.type === 'tool/call') {
            audit.append(chainId, 'tool/call', event.data)
            return
          }
          if (event.type === 'tool/result') {
            // B4：只上摘要。content/reason 不进链（PII/体积）；完整结果仍在 session.jsonl，
            // replay 用会话侧重算同一摘要做硬比对——两侧任一被篡改都会变红。
            audit.append(chainId, 'tool/result', toolResultSummaryOf(event.data))
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

  validate(config) {
    rejectUnknownKeys(config, ['signingKeyPath'], 'audit:decisions')
    const signingKeyPath = config['signingKeyPath']
    if (
      signingKeyPath !== undefined &&
      (typeof signingKeyPath !== 'string' || signingKeyPath.length === 0)
    ) {
      throw new BahError('invalid-config', 'audit:decisions.signingKeyPath 必须是非空字符串')
    }
    return {
      signingKeyPath:
        typeof signingKeyPath === 'string' && signingKeyPath.length > 0
          ? signingKeyPath
          : DEFAULT_SIGNING_KEY_PATH,
    }
  },
}
