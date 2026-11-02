/**
 * 银行工具族的治理平面。
 *
 * 三个挂点，全部经 `ctx.events`（不私建旁路）：
 * 1. `tools/pre-execute`（waterfall）：身份 → 预检 → `decide()` 判定矩阵 → `allow / ask / deny`；
 *    每次判决落 `tier/decided` 审计事件；
 * 2. `approval/request`（waterfall）：把管线铸造的三字段票据桥接成 bank-core 的五绑定票据，
 *    再交给下游（`@bah/interaction` 的审批服务）仲裁；应答后同步 `issued → approved / blocked`；
 * 3. `tools/result`（emit）：按 core 的票据状态记账（`redeemed + 成功 → consumed`，其余 → `blocked`）。
 *
 * 票据生命周期账本（`ticket/*` 事件）由宿主注入（`@bah/interaction` 的 `TicketLedger`）：
 * 本包只负责**五绑定组装与核销边界**，不持有跨 turn 的待审批状态（R90）。
 */

import { BahError, assertNever, errorCodeOf, logJson, reasonOf } from '@bah/util'

import type { Context, SessionId, TicketAuthorization, TicketDetail, TicketDraft, TicketId, ToolTierLevel } from '@bah/core'
import type { BankTierInput } from '@bah/policy'
import type { PolicyDecision, PolicyEngine } from '@bah/runtime'

import type { TransferPreview } from '../core/provider.ts'
import type { AaGroupId } from '../core/model.ts'
import { bankIds, checkSuitability, yuanToCents } from '../core/index.ts'
import { requireAccount } from './accounts.ts'
import { detailsForCall } from './approval-details.ts'
import { readNumber, readOptionalString, readString } from './args.ts'
import { fingerprintOf } from './fingerprint.ts'
import { assertExecutableNow, parsePurchaseAmount, parseTransferInput } from './inputs.ts'
import {
  buildTierInput,
  createTierPolicy,
  evidenceOf,
  paramsDigestOf,
  tierEvaluationParams,
  tierParamsOf,
  type PolicyEvidence,
} from './policy.ts'
import { BANK_TOOL_NAME_SET, specOf, type BankToolName, type BankToolSpec } from './specs.ts'
import { decide, isReadOnlyAction, isRiskyOp, TIER_REASONS, type TierConfig, type TierDecision, type TierReason } from './tier.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'
import type { BankSessionEventMap } from './events.ts'

/** 本地结构类型：避免把 `@bah/runtime` 拖进本包（接缝形状与 `seams.ts` 一致）。 */
interface ToolCallLike {
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

type DenyVerdict = { readonly kind: 'deny'; readonly reason: string; readonly code: string }

type VerdictLike =
  | { readonly kind: 'allow' }
  | DenyVerdict
  | {
      readonly kind: 'ask'
      readonly ticket: TicketDraft
      readonly challenge?: 'face' | 'sms' | 'ushield'
    }

interface PreExecuteLike {
  readonly call: ToolCallLike
  readonly verdict: VerdictLike
}

interface ApprovalLike {
  readonly ticket: {
    readonly ticketId: string
    readonly fingerprint: string
    readonly amount?: number
    readonly expiresAt: number
  }
  readonly callId: string
  readonly name: string
  /** 授权来源（ADR-0008；缺省 = 人工点击）。 */
  readonly authorization?: TicketAuthorization
  readonly decision: {
    readonly decision: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    readonly reason?: string
  }
}

interface ToolResultLike {
  readonly callId: string
  readonly isError: boolean
  readonly code?: string
}

/**
 * 票据生命周期端口（宿主传入 `@bah/interaction` 的 `TicketLedger`）。
 *
 * 本包声明**结构类型**而不是 import interaction：判定/治理不该反向依赖交互包，
 * 宿主是唯一知道两个包的地方（接缝形状与 `@bah/core` 的 `TicketRef` 无关）。
 */
export interface TicketLifecycleIssueInput {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly fingerprint: string
  readonly amountCents?: number
  readonly expiresAt: number
  /**
   * 执行 lease（W12；宿主生成后随票据一起注入）。
   *
   * 结构内联：bank 包不 import `@bah/runtime`，也不在治理面再定义一份 `TicketLease`。
   */
  readonly lease?: {
    readonly leaseId: string
    readonly expiresAt: number
  }
  /** 授权来源（ADR-0008；缺省 = 人工点击）。 */
  readonly authorization?: TicketAuthorization
  readonly at: number
}

/** 票据生命周期账本的最小面（见 `@bah/interaction` 的 `TicketLedger`）。 */
export interface TicketLifecycle {
  issue(input: TicketLifecycleIssueInput): unknown
  approve(ticketId: string, at: number, authorization?: TicketAuthorization): unknown
  redeem(ticketId: string, at: number): unknown
  consume(ticketId: string, at: number): unknown
  block(ticketId: string, reason: string, at: number): unknown
}

/** 装配参数。 */
export interface BankGovernanceOptions {
  readonly ctx: Context
  readonly sessionId: SessionId
  readonly deps: BankToolDeps
  /** 票据生命周期账本（缺省 = 只记 bank-core 状态，不落 `ticket/*` 事件；单测可用）。 */
  readonly lifecycle?: TicketLifecycle
  /**
   * 策略引擎（W04）。缺省 = `createTierPolicy(tierConfig)`，即既有 `tier.ts` 的判决。
   *
   * 注入的引擎只能**加严**：`deny` 生效，`allow` 不能把黄/红降级（组合规则见 `evaluateCall`）。
   *
   * **也接受函数**（策略外置 S2）：每次判决时重新解析。这是"后置服务也能生效"与
   * "热重载换引擎不用重建治理平面"的前提（03 §2.1 的第二道防线）。传函数时每次
   * 判决都调用一次——返回 `undefined` 表示服务不可用，按 `policyEngineMode` fail-closed。
   */
  readonly policy?: PolicyEngine | (() => PolicyEngine | undefined)
  /**
   * 策略引擎模式（策略外置 S2）：`legacy`（缺省）| `bundle`。
   *
   * 只影响"服务缺失"的处理：`bundle` 时缺服务是启动错误（`policy-service-missing`），
   * 运行期若仍拿不到引擎则 deny `policy-unavailable`。`legacy` 时缺服务回落到
   * `createTierPolicy`——**这是唯一允许的隐式回退**，且只在显式配了 `legacy` 时发生（I15）。
   */
  readonly policyEngineMode?: 'legacy' | 'bundle'
  /**
   * 当前生效的策略版本（早拒路径写进 `tier/decided`）。
   *
   * 早拒（sentry 先拒 / 未绑定身份 / 预检失败）**不跑策略**，但仍要回答
   * "当时生效的是哪版策略"，所以取当前生效版本而不是"未判定"（02 §4.2）。
   * 缺省 `legacy`。
   */
  readonly activePolicyVersion?: string | (() => string)
  /**
   * 执行 lease（W12）：`enforce = false` 时退回"只用票据 TTL"的旧行为。
   *
   * lease 的到期时刻 = `min(票据 TTL, 签发时刻 + ttlMs)`，写进 bank-core 五绑定的
   * `expiresAt`——**核销点**就是执行点，不存在"钱先出去、账本再拦"的窗口。
   */
  readonly lease?: {
    readonly enforce: boolean
    readonly ttlMs: number
  }
  /**
   * 当前进程的租户（03 TA-47）。
   *
   * 会话绑定时记录了租户；两者不一致说明会话身份被搬到别的租户下复用——
   * 这是比"没身份"更严重的越权，所以 `wrong-tenant` 排在 `no-identity` 之前。
   * 缺省 `undefined` = 旧装配 / 单测，不判租户（不改变既有行为）。
   */
  readonly tenantId?: string
}

/**
 * 一次判决的完整审计记录（`tier/decided` 的载荷）。
 *
 * `engineSource` / `policyVersion` / `ruleIds` / `paramsDigest` / `evidence` 是
 * 策略外置 S2 的增量：legacy 模式也写（值分别是 `legacy` / `legacy` / `[]` / 真实摘要 / 无证据），
 * 这样 metrics 与 explain 只有一条读法（02 §4.2 的四条落账路径）。
 */
interface DecisionAudit {
  readonly verdict: VerdictLike
  readonly level: ToolTierLevel
  readonly reason: TierReason
  readonly code?: string
  readonly engineSource: 'legacy' | 'bundle'
  readonly policyVersion: string
  readonly ruleIds: readonly string[]
  readonly evidence?: PolicyEvidence
}

/**
 * 装配治理平面（幂等注册；随 ctx dispose 自动撤销）。
 *
 * @throws 仅在装配期抛（配置 / 依赖错误）；运行期判决一律走 `allow / ask / deny`
 */
export function provideBankGovernance(options: BankGovernanceOptions): void {
  const { ctx, sessionId, deps, lifecycle } = options
  const now = clockOf(deps)
  const tierConfig: TierConfig = {
    dailyTransferLimitCents: yuanToCents(deps.config.dailyTransferLimit),
    riskyOps: deps.config.riskyOps,
    riskyCallThreshold: deps.config.riskyCallThreshold,
  }
  // 默认实现直接委托 tier.ts；注入的引擎只能加严（见 evaluateCall 的组合规则）
  const legacyPolicy = createTierPolicy(tierConfig)
  const mode = options.policyEngineMode ?? 'legacy'
  /**
   * 当前生效版本：**每次判决时求值**。热重载之后早拒路径也要写新版本；
   * 在装配期捕获字符串会把之后的所有早拒判决钉在旧版本上（I12）。
   */
  const activeVersionOf: () => string =
    typeof options.activePolicyVersion === 'function'
      ? options.activePolicyVersion
      : () => {
          const fixed = options.activePolicyVersion
          return typeof fixed === 'string' ? fixed : 'legacy'
        }
  /**
   * 参数摘要（审计口径）：覆盖 `riskyOps` / 日限额 / 挑战渠道 / 阈值四个部署参数。
   * 必须在这里算一次——每笔都算等于每笔都 sha256 一次，纯函数但没有收益。
   */
  const paramsDigest = paramsDigestOf(tierParamsOf(tierConfig, deps.config.redChallenge))
  /** 求值参数（只有 bundle 声明过的 `riskyCallThreshold`；见 `tierEvaluationParams`）。 */
  const evaluationParams = tierEvaluationParams(tierConfig)
  /**
   * 每次判决解析一次策略。
   *
   * 传函数时**不缓存返回值**：热重载换掉 `runtime:policy` 之后，下一次判决就拿到新引擎；
   * 传对象时就是那个对象。
   *
   * 缺省回落到 `legacyPolicy`（= 既有 `tier.ts`），**但只在 `legacy` 模式**：
   * `bundle` 模式缺服务必须 deny `policy-unavailable`，否则"策略可选"会让
   * 一次装配失误变成静默降级（I15）。
   */
  const lookupPolicy = (): PolicyEngine | undefined => {
    const candidate = typeof options.policy === 'function' ? options.policy() : options.policy
    if (candidate !== undefined) return candidate
    return mode === 'bundle' ? undefined : legacyPolicy
  }
  /** 组合风险是「同一 turn 内」的口径：turn/start 重置（跨 turn 的日累计由 core 账本负责）。 */
  let riskyCallsInTurn = 0

  /**
   * 落一条判决审计；**写失败不改判决**（I17）。
   *
   * 审计出口是会话事件（host）或内存数组（测试），两者都可能因为下游故障抛错。
   * 这里只告警：已经算出的 allow/ask/deny 不因"账没记上"而翻转——记不上账是
   * 可观测性问题，不是拒绝用户的理由。
   */
  const appendTierDecided = (data: BankSessionEventMap['tier/decided']): void => {
    try {
      deps.audit.append('tier/decided', data)
    } catch (error) {
      logJson('warn', 'bank.tier-persist-failed', { reason: reasonOf(error) })
    }
  }

  /**
   * `callId → ticketId` 映射。
   *
   * 票据 ID 现在是随机 UUID，`tools/result` 只带 `callId`，反推不出票据。
   * 审批桥接（`approval/request`）手上两样都有，就在那里记一笔。
   */
  const ticketOfCall = new Map<string, TicketId>()

  ctx.effect(
    ctx.events.on('session/event', (payload) => {
      const envelope = payload as { readonly event?: { readonly type?: unknown } }
      if (envelope.event?.type === 'turn/start') riskyCallsInTurn = 0
    }),
  )

  // ① 执行前判决：下游（危险规则 / sentry）先说话；下游 deny 永远赢
  ctx.effect(
    ctx.events.on('tools/pre-execute', async (payload, next) => {
      const input = payload as PreExecuteLike
      const downstream = (await next(payload)) as PreExecuteLike
      if (!BANK_TOOL_NAME_SET.has(input.call.name)) return downstream

      // 安全层（sentry）在 bank 评估前先拒：补一条声明级判决，保证 bank 审计链完整。
      // 与 no-identity 的早期拒绝同口径——不跑预检/decide()，level 记声明级别。
      // `policyVersion` 取**当前生效版本**、`ruleIds: []` 表示"没有规则参与"（02 §4.2）。
      if (downstream.verdict.kind === 'deny' && downstream.verdict.code.startsWith('sentry-')) {
        const spec = specOf(input.call.name as BankToolName)
        appendTierDecided({
          callId: input.call.callId,
          name: spec.name,
          level: spec.tier.level,
          reason: 'declared',
          verdict: 'deny',
          code: downstream.verdict.code,
          at: now(),
          policyVersion: activeVersionOf(),
          ruleIds: [],
          paramsDigest,
          engineSource: mode,
        })
        return downstream
      }
      if (downstream.verdict.kind !== 'allow') return downstream

      const spec = specOf(input.call.name as BankToolName)
      // 合约期硬拦：必须在**签票/审批之前**。工具 execute 里的同一检查只服务直接调用
      // （测试 / CLI），不能替代这一层——否则用户先看到审批弹窗，点完才被告知"合约期内"。
      const hardBlock = await subscriptionContractBlock(deps, sessionId, spec.name, input.call.args, now)
      if (hardBlock !== undefined) {
        appendTierDecided({
          callId: input.call.callId,
          name: spec.name,
          level: spec.tier.level,
          reason: 'declared',
          verdict: 'deny',
          code: hardBlock.code,
          at: now(),
          policyVersion: activeVersionOf(),
          ruleIds: [],
          paramsDigest,
          engineSource: mode,
        })
        return {
          ...downstream,
          verdict: { kind: 'deny', code: hardBlock.code, reason: hardBlock.message },
        }
      }
      const audit = await evaluateCall({
        deps,
        sessionId,
        call: input.call,
        spec,
        config: tierConfig,
        riskyCallsInTurn,
        now,
        mode,
        activeVersion: activeVersionOf,
        paramsDigest,
        evaluationParams,
        lookupPolicy,
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      })
      appendTierDecided({
        callId: input.call.callId,
        name: spec.name,
        level: audit.level,
        reason: audit.reason,
        verdict: audit.verdict.kind,
        ...(audit.code === undefined ? {} : { code: audit.code }),
        at: now(),
        policyVersion: audit.policyVersion,
        ruleIds: audit.ruleIds,
        paramsDigest,
        engineSource: audit.engineSource,
        ...(audit.evidence === undefined ? {} : { evidence: audit.evidence }),
      })

      if (audit.verdict.kind !== 'deny' && isRiskyOp(tierConfig, spec.name)) {
        riskyCallsInTurn += 1
      }
      return audit.verdict.kind === 'allow' ? downstream : { ...downstream, verdict: audit.verdict }
    }),
  )

  // ② 审批桥接：三字段票据 → 五绑定票据；应答后同步状态 + 记账
  ctx.effect(
    ctx.events.on('approval/request', async (payload, next) => {
      const input = payload as ApprovalLike
      if (!BANK_TOOL_NAME_SET.has(input.name)) return next(payload)

      const ticketId = input.ticket.ticketId as TicketId
      const issuedAt = now()
      // 这里是唯一同时见到 callId 与 ticketId 的地方：记下映射，`tools/result` 才找得到票据
      ticketOfCall.set(input.callId, ticketId)
      // W12：lease 窗口从签发时刻起算；到期时刻同时写进 bank-core 五绑定，
      // 于是核销（= 执行）时由 TicketStore 自己拒绝过期票据，不靠事后记账补拦。
      const leaseExpiresAt =
        options.lease?.enforce === true
          ? Math.min(input.ticket.expiresAt, issuedAt + options.lease.ttlMs)
          : input.ticket.expiresAt
      const lease =
        options.lease?.enforce === true
          ? { leaseId: `lease:${ticketId}`, expiresAt: leaseExpiresAt }
          : undefined
      const binding = {
        sessionId,
        tool: input.name,
        fingerprint: input.ticket.fingerprint,
        amountCents: centsOf(input.ticket.amount),
        expiresAt: leaseExpiresAt,
      }
      if (deps.tickets.get(ticketId) === undefined) {
        try {
          deps.tickets.issue(ticketId, binding, issuedAt)
        } catch (error) {
          return {
            ...input,
            decision: { decision: 'unavailable', reason: reasonOf(error) },
          }
        }
        ledgerSafely(deps, ticketId, 'issue', issuedAt, () =>
          lifecycle?.issue({
            ticketId,
            callId: input.callId,
            name: input.name,
            fingerprint: binding.fingerprint,
            amountCents: binding.amountCents,
            expiresAt: binding.expiresAt,
            ...(lease === undefined ? {} : { lease }),
            ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
            at: issuedAt,
          }),
        )
      }

      const answered = (await next(payload)) as ApprovalLike
      const decidedAt = now()
      if (answered.decision.decision === 'allowed-once') {
        try {
          deps.tickets.approve(ticketId, decidedAt)
        } catch (error) {
          // 票据过期等：宁可拒绝，也不带着无效票据去执行
          ledgerSafely(deps, ticketId, 'block', decidedAt, () =>
            lifecycle?.block(ticketId, reasonOf(error), decidedAt),
          )
          return {
            ...answered,
            decision: { decision: 'unavailable', reason: reasonOf(error) },
          }
        }
        // 记账失败只留审计证据：core 票据已批准，不能因为账本异常改写审批结论
        ledgerSafely(deps, ticketId, 'approve', decidedAt, () =>
          lifecycle?.approve(ticketId, decidedAt, answered.authorization),
        )
      } else {
        const reason = answered.decision.reason ?? `approval-${answered.decision.decision}`
        try {
          deps.tickets.block(ticketId, reason, decidedAt)
        } catch {
          // 已关闭的票据（重复应答 / 已核销）不再改写状态；审批结论照常返回
        }
        ledgerSafely(deps, ticketId, 'block', decidedAt, () =>
          lifecycle?.block(ticketId, reason, decidedAt),
        )
      }
      return answered
    }),
  )

  // ③ 结果记账：成功 → consumed；失败 / 拒绝 / 超时 → blocked
  ctx.effect(
    ctx.events.on('tools/result', (payload) => {
      const result = payload as ToolResultLike
      // 票据 ID 是 UUID，只能从审批期记下的映射里取；取不到再退回旧派生（无票据的调用本来就会 return）
      const ticketId = ticketOfCall.get(result.callId) ?? ticketIdOf(result.callId)
      // emit 是同步派发：本监听器抛错会炸穿管线（资金已动、日志记失败）。
      // 记账只做旁路：任何异常都降级为审计事件，绝不改变 `tool/result` 的权威结论。
      try {
        const status = deps.tickets.status(ticketId)
        if (status === undefined) return
        const at = now()
        if (status === 'redeemed') {
          ledgerSafely(deps, ticketId, 'redeem', at, () => lifecycle?.redeem(ticketId, at))
          if (result.isError) {
            ledgerSafely(deps, ticketId, 'block', at, () =>
              lifecycle?.block(ticketId, result.code ?? 'tool-failed', at),
            )
          } else {
            ledgerSafely(deps, ticketId, 'consume', at, () => lifecycle?.consume(ticketId, at))
          }
          return
        }
        if (status === 'approved') {
          ledgerSafely(deps, ticketId, 'block', at, () =>
            lifecycle?.block(
              ticketId,
              result.isError ? (result.code ?? 'tool-failed') : 'not-redeemed',
              at,
            ),
          )
          return
        }
        if (status === 'issued') {
          ledgerSafely(deps, ticketId, 'block', at, () =>
            lifecycle?.block(ticketId, 'approval-not-completed', at),
          )
        }
      } catch (error) {
        reportLedgerFailure(deps, ticketId, 'result', now(), error)
      }
    }),
  )
}

/** `evaluateCall` 的入参（对象形式：位置参数已经多到读不出顺序）。 */
interface EvaluateArgs {
  readonly deps: BankToolDeps
  readonly sessionId: SessionId
  readonly call: ToolCallLike
  readonly spec: BankToolSpec
  readonly config: TierConfig
  readonly riskyCallsInTurn: number
  readonly now: () => number
  readonly mode: 'legacy' | 'bundle'
  readonly activeVersion: () => string
  readonly paramsDigest: string
  readonly evaluationParams: Readonly<Record<string, number>>
  readonly lookupPolicy: () => PolicyEngine | undefined
  /** 当前进程租户（03 TA-47）；缺省不判租户。 */
  readonly tenantId?: string
}

/**
 * 一次调用的完整判定（02 §2.1 的九步，顺序即安全边界）。
 *
 * ```text
 * 1 身份 → 2 预检 → 3 生效上限 min(core, config) → 4 构造 PolicyInput
 * → 5 非绿则问策略（异常=deny、缺服务=deny、拿到 level/reason 作 escalation）
 * → 6 decide(input, escalation)（硬规则在这里，策略改不动）
 * → 7 策略 deny 覆盖（仅当第 6 步不是 deny）
 * ```
 *
 * 预检（余额 / 收款人 / 理财产品）属于"这一笔注定失败"的拒绝，必须在签发票据前完成；
 * 判决本身是纯函数（`tier.ts`），这里只做异步取数。
 */
/**
 * `sub_cancel` 的合约期硬拦（pre-execute 层）。
 *
 * 只在「没有显式确认 + 订阅确实在合约期」时返回 deny。直接调用工具体时由 execute 里的
 * 同一检查兜底；两层读同一个 `contractEndAt`，不会出现两套阈值。
 */
async function subscriptionContractBlock(
  deps: BankToolDeps,
  sessionId: SessionId,
  name: string,
  args: Readonly<Record<string, unknown>>,
  now: () => number,
): Promise<{ readonly code: string; readonly message: string } | undefined> {
  if (name !== 'sub_cancel' || args['confirmContract'] === true) return undefined
  const subscriptionId =
    typeof args['subscriptionId'] === 'string' ? args['subscriptionId'] : undefined
  if (subscriptionId === undefined) return undefined
  const bound = deps.identity.resolve(sessionId)
  if (bound === undefined) return undefined
  const subscriptions = await deps.core.listSubscriptions(bankIds.user(bound))
  const found = subscriptions.find((item) => String(item.id) === subscriptionId)
  if (found?.contractEndAt === undefined || found.contractEndAt <= now()) return undefined
  return {
    code: 'subscription-contract-active',
    message: `订阅处于合约期（至 ${new Date(found.contractEndAt).toISOString().slice(0, 10)}），需用户显式确认后才能取消`,
  }
}

async function evaluateCall(args: EvaluateArgs): Promise<DecisionAudit> {
  const { deps, sessionId, call, spec, config, riskyCallsInTurn, now, mode } = args
  /** 早拒路径的统一形状：当前生效版本 + 空规则集 + 当前模式（02 §4.2 第三条）。 */
  const early = (verdict: DenyVerdict, level: ToolTierLevel): DecisionAudit => ({
    verdict,
    level,
    reason: 'declared',
    code: verdict.code,
    engineSource: mode,
    policyVersion: args.activeVersion(),
    ruleIds: [],
  })

  /**
   * 租户闸（03 TA-47）：**在 no-identity 之前**。
   * 跨租户是比"没身份"更严重的越权，先报它，审计上才看得见"有人在试跨租户"。
   * 历史绑定可能没有租户（旧载荷 / 旧调用），此时不误拒。
   */
  const binding = deps.identity.resolveIdentity?.(sessionId)
  if (
    args.tenantId !== undefined &&
    binding?.tenantId !== undefined &&
    binding.tenantId !== args.tenantId
  ) {
    return early(
      { kind: 'deny', code: 'wrong-tenant', reason: '会话身份与当前租户不一致' },
      spec.tier.level,
    )
  }

  const userId = binding?.userId ?? deps.identity.resolve(sessionId)
  if (userId === undefined || userId.trim().length === 0) {
    return early(
      { kind: 'deny', code: 'no-identity', reason: '当前会话未绑定银行用户身份' },
      spec.tier.level,
    )
  }

  let preview: TransferPreview | undefined
  let amountCents = 0
  if (spec.name === 'transfer_create') {
    const checked = await transferPreview(deps, userId, call, now)
    if ('deny' in checked) return early(checked.deny, spec.tier.level)
    preview = checked.preview
    amountCents = checked.preview.amountCents
  }

  if (spec.name === 'wealth_purchase') {
    const checked = await checkWealthPurchase(deps, call, userId)
    if ('deny' in checked) return early(checked.deny, spec.tier.level)
    amountCents = checked.amountCents
  }

  if (spec.name === 'wealth_redeem') {
    const checked = await checkWealthRedeem(deps, call, userId)
    if ('deny' in checked) return early(checked.deny, spec.tier.level)
    amountCents = checked.amountCents
  }

  // B-05：代收的票据金额 = **该参与人的份额**。不先算出来，审批卡上就只剩一个
  // 没有金额的"执行 aa_create"，用户批准的东西和真正入账的金额对不上。
  // 这里只做只读预览（`getAa`）；执行期的完整五道校验仍在 core。
  //
  // ADR-0017：`decline` 走同一套定位校验（票面金额为 0，它不动钱）；
  // `close` 只校验组存在且仍在收款，不挑参与人。
  const aaAction = call.args['action']
  if (spec.name === 'aa_create' && (aaAction === 'collect' || aaAction === 'decline')) {
    const checked = await checkAaParticipant(deps, call, userId, aaAction)
    if ('deny' in checked) return early(checked.deny, spec.tier.level)
    amountCents = checked.amountCents
  }
  if (spec.name === 'aa_create' && aaAction === 'close') {
    const checked = await checkAaClose(deps, call, userId)
    if ('deny' in checked) return early(checked.deny, spec.tier.level)
  }

  const verifyLocked = deps.verify.isLocked(sessionId)
  /**
   * 只读动作（`READ_ONLY_ACTIONS` 封闭表）：`risk_assess(action="questions")` 取问卷
   * 不写库，因此既不问策略、也不签票据。判定本身仍在 `tier.ts`——这里只把事实传下去，
   * **不在治理面另写一遍"哪些 action 是只读"**。
   */
  const readOnlyAction = isReadOnlyAction(spec.name, call.args)

  // 第 3 步：生效上限。数据只能**收紧** Config——`min` 的方向不可交换。
  const dailyLimitCents =
    preview === undefined
      ? config.dailyTransferLimitCents
      : Math.min(preview.dailyLimitCents, config.dailyTransferLimitCents)

  // 第 5 步：策略意见（W04）。只咨询**非绿**工具——读操作不受策略拒绝影响（TC-W04-06）。
  // `escalation` 只有 bundle 实现会填：legacy 实现不填 level/tierReason，于是第 6 步
  // 仍走内部升级（行为逐字不变）。这是"一个端口两种实现"的关键，不是巧合。
  let escalation: TierDecision | undefined
  let policyDeny: DenyVerdict | undefined
  let evidence: PolicyEvidence | undefined
  let engineSource: 'legacy' | 'bundle' = mode
  let policyVersion = args.activeVersion()
  let ruleIds: readonly string[] = []

  if (spec.tier.level !== 'green' && !readOnlyAction) {
    const engine = args.lookupPolicy()
    if (engine === undefined) {
      // 运行期兜底：启动期本应 `policy-service-missing`（I15 的"没有静默回退"）。
      return early(
        {
          kind: 'deny',
          code: 'policy-unavailable',
          reason: '策略引擎不可用：engine=bundle 但未装配 policy:rules（fail-closed）',
        },
        spec.tier.level,
      )
    }

    const input = buildTierInput({
      userId,
      sessionId: String(sessionId),
      name: spec.name,
      declared: spec.tier.level,
      state: { riskyCallsInTurn, verifyLocked },
      ...(preview === undefined ? {} : { preview }),
      dailyLimitCents,
      params: args.evaluationParams,
    })

    let stance: PolicyDecision
    try {
      stance = engine.decide(
        { userId, sessionId: String(sessionId) },
        { name: spec.name, declared: spec.tier.level, kind: 'bank.tier' },
        {
          riskyCallsInTurn,
          verifyLocked,
          ...(preview === undefined ? {} : { preview }),
          input,
        },
      )
    } catch (error) {
      // 求值器抛错（IR 损坏 / 溢出 / 未知 op / 输入非法）→ **绝不 allow**（I5）。
      return {
        verdict: { kind: 'deny', code: 'policy-engine-error', reason: reasonOf(error) },
        level: spec.tier.level,
        reason: 'declared',
        code: 'policy-engine-error',
        engineSource: 'bundle',
        policyVersion: args.activeVersion(),
        ruleIds: [],
      }
    }

    if (stance.level !== undefined) {
      // bundle 实现：四个字段是一组，缺一个就按引擎异常处理（不许"半升级"）。
      // 这里也在 try 里：形状不对必须收敛成 deny，而不是把异常抛穿工具管线。
      try {
        escalation = {
          level: assertTierLevel(stance.level),
          reason: assertTierReason(stance.tierReason),
        }
        engineSource = 'bundle'
        policyVersion = assertPolicyVersion(stance.policyVersion)
        ruleIds = assertRuleIds(stance.ruleIds)
        evidence = evidenceOf(input)
      } catch (error) {
        // 证据超限（> 1 KiB）或引擎返回非法形状：宁可拒绝，也不写一条不可复核的判决。
        const code = errorCodeOf(error, 'policy-engine-error')
        return {
          verdict: { kind: 'deny', code, reason: reasonOf(error) },
          level: spec.tier.level,
          reason: 'declared',
          code,
          engineSource: 'bundle',
          policyVersion: args.activeVersion(),
          ruleIds: [],
        }
      }
    } else {
      engineSource = 'legacy'
    }

    if (stance.verdict === 'deny') {
      policyDeny = {
        kind: 'deny',
        code: stance.code ?? 'policy-denied',
        reason: stance.reason,
      }
    }
  }

  // 第 6 步：判定矩阵。硬不变量（未绑定 / 锁定中 / min 上限）在这里，策略改不动。
  const decision = decide(
    {
      name: spec.name,
      declared: spec.tier.level,
      config,
      state: { userId, riskyCallsInTurn, verifyLocked },
      ...(preview === undefined ? {} : { preview }),
      ...(readOnlyAction ? { readOnlyAction: true } : {}),
    },
    escalation,
  )

  const auditOf = (level: ToolTierLevel, reason: TierReason): Pick<
    DecisionAudit,
    'level' | 'reason' | 'engineSource' | 'policyVersion' | 'ruleIds'
  > & { readonly evidence?: PolicyEvidence } => ({
    level,
    reason,
    engineSource,
    policyVersion,
    ruleIds,
    ...(evidence === undefined ? {} : { evidence }),
  })

  // 第 7 步：策略 deny 覆盖（只在判定矩阵没判 deny 时生效——硬规则优先）。
  if (policyDeny !== undefined && decision.kind !== 'deny') {
    return {
      verdict: policyDeny,
      code: policyDeny.code,
      ...auditOf(decision.level, 'declared'),
    }
  }

  switch (decision.kind) {
    case 'allow':
      return { verdict: { kind: 'allow' }, ...auditOf(decision.level, decision.reason) }
    case 'ask': {
      /**
       * 审批明细：只在**真要签发**的分支构造（allow/deny 不读账本，省一次往返）。
       *
       * `detailsForCall` 自带"不抛错"契约；这里再兜一层 `catch` 是因为它站在
       * 安全边界上——明细构造失败必须降级成"没有明细"，不是"审批发不出去"。
       * 传 `preview`：transfer_create 的试算上面已经算过，不重复读账本。
       */
      const details = await detailsForCall(deps, userId, spec, call.args, {
        ...(preview === undefined ? {} : { preview }),
      }).catch(() => [])
      return {
        verdict: {
          kind: 'ask',
          ticket: {
            fingerprint: fingerprintOf(call.name, call.args),
            amount: amountCents / 100,
            ttlMs: deps.config.ticketTtlSeconds * 1000,
            ...(details.length === 0 ? {} : { details }),
          },
          ...(decision.challenge ? { challenge: deps.config.redChallenge } : {}),
        },
        ...auditOf(decision.level, decision.reason),
      }
    }
    case 'deny':
      return {
        verdict: { kind: 'deny', code: decision.code, reason: decision.reason },
        code: decision.code,
        ...auditOf(decision.level, 'declared'),
      }
    default:
      // 构造不可达：封闭联合已穷尽（纪律 6 要求收尾）
      /* v8 ignore next */
      return assertNever(decision, 'governance-decision')
  }
}

/**
 * 校验 bundle 返回的级别（`PolicyDecision.level` 是 `ToolTierLevel`，但引擎可以是任意实现）。
 *
 * 非法值 = 引擎异常 → 抛错被治理平面收敛成 `policy-engine-error`（02 §2.2）。
 */
function assertTierLevel(value: ToolTierLevel): ToolTierLevel {
  if (value === 'green' || value === 'yellow' || value === 'red') return value
  throw new BahError('policy-engine-error', `策略返回了未知级别 ${String(value)}`)
}

/** 理由词表是封闭四值（D10）：非法理由会污染审计与前端枚举，按引擎异常处理。 */
function assertTierReason(value: string | undefined): TierReason {
  const reason = value ?? 'declared'
  if ((TIER_REASONS as readonly string[]).includes(reason)) return reason as TierReason
  throw new BahError('policy-engine-error', `策略返回了未知理由 ${reason}`)
}

/**
 * 版本身份必须非空（链信封要求）；bundle 引擎必须给出自己的身份。
 *
 * 缺省值只服务 legacy 实现（它不填 `level`，走不到这里）。
 */
function assertPolicyVersion(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new BahError('policy-engine-error', '策略引擎返回了升级结果但没有 policyVersion')
  }
  return value
}

/** 命中规则集必须是非空字符串数组（I12：每条 bundle 判决至少命中一个默认行）。 */
function assertRuleIds(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined || value.length === 0) {
    throw new BahError('policy-engine-error', '策略引擎返回了升级结果但没有 ruleIds')
  }
  for (const id of value) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new BahError('policy-engine-error', `策略返回了非法 ruleId ${String(id)}`)
    }
  }
  return value
}

/**
 * 转账的执行前预检（余额 / 风控 block 规则 / 参数）。
 *
 * 只返回预检结果或拒绝：日累计 / 新收款人的**级别**由 `decide()` 的升级规则统一判定，
 * 这样试算卡片与执行判定共用同一口径（`transfers.ts` 的 `toTransferPreview`）。
 */
async function transferPreview(
  deps: BankToolDeps,
  userId: string,
  call: ToolCallLike,
  now: () => number,
): Promise<{ readonly preview: TransferPreview } | { readonly deny: DenyVerdict }> {
  let input
  try {
    input = parseTransferInput(call.args)
    assertExecutableNow(input.when, now())
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error, 'tool-failed'), reason: reasonOf(error) } }
  }
  let account
  try {
    account = await requireAccount(deps, userId)
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error, 'tool-failed'), reason: reasonOf(error) } }
  }
  try {
    const preview = await deps.core.previewTransfer({
      fromAccountId: account.id,
      payee: input.payee,
      amountCents: input.amountCents,
      channel: 'app',
      ...(input.viaCardId === undefined ? {} : { viaCardId: input.viaCardId }),
    })
    const blocked = preview.risks.find((risk) => risk.severity === 'block')
    if (blocked !== undefined) {
      return { deny: { kind: 'deny', code: blocked.code, reason: blocked.message } }
    }
    return { preview }
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error, 'tool-failed'), reason: reasonOf(error) } }
  }
}

/**
 * AA 参与人动作的票前预览（B-05 / ADR-0017）：只读定位参与人。
 *
 * 与 core 的 `collectAa` / `declineAa` 同一套定位规则（序号 `"0"…"9"` / 姓名精确、
 * 同名多位歧义）；这里**只做金额预览**，不写库。执行期 core 会按完整顺序再校一遍——
 * 预览与执行分开是既有模式（transfer preview 同样先算一次）。
 *
 * `decline` 的票面金额是 0：拒绝不产生入账，审批卡不该显示一个会被"收"的金额。
 */
async function checkAaParticipant(
  deps: BankToolDeps,
  call: ToolCallLike,
  userId: string,
  action: 'collect' | 'decline',
): Promise<{ readonly amountCents: number } | { readonly deny: DenyVerdict }> {
  try {
    const groupId = readOptionalString(call.args, 'groupId', 'aa_create')
    if (groupId === undefined) {
      return {
        deny: {
          kind: 'deny',
          code: 'tool-args-invalid',
          reason: `aa_create.${action} 需要 groupId`,
        },
      }
    }
    const raw = readOptionalString(call.args, 'participant', 'aa_create')
    if (raw === undefined) {
      return {
        deny: {
          kind: 'deny',
          code: 'tool-args-invalid',
          reason: `aa_create.${action} 需要 participant（姓名或序号）`,
        },
      }
    }
    const group = await deps.core.getAa(bankIds.user(userId), groupId as AaGroupId)
    if (group === undefined) {
      return { deny: { kind: 'deny', code: 'aa-unknown', reason: `找不到 AA 组 ${groupId}` } }
    }
    if (group.status !== 'collecting') {
      // completed 组对已付参与人的重复 collect 与 collecting 分支同口径（复审 P1-3）：
      // 执行期 core 也返回 `aa-participant-paid`，票前预览不能先报另一个码。
      if (group.status === 'completed') {
        const paid = resolveAaParticipant(group.participants, raw)
        if (typeof paid === 'number' && group.participants[paid]?.status === 'paid') {
          return {
            deny: {
              kind: 'deny',
              code: 'aa-participant-paid',
              reason: `${group.participants[paid]!.name} 的份额已经收过`,
            },
          }
        }
      }
      return {
        deny: {
          kind: 'deny',
          code: 'aa-group-closed',
          reason: `AA 组状态为 ${group.status}，不能再${action === 'collect' ? '代收' : '改状态'}`,
        },
      }
    }
    // 到期 job 还没跑 ≠ 还能代收：窗口是事实，job 只是收口动作（复审 P1-2）。
    if (action === 'collect' && group.expiresAt !== undefined && group.expiresAt < clockOf(deps)()) {
      return {
        deny: {
          kind: 'deny',
          code: 'aa-group-closed',
          reason: 'AA 组已过收款截止时间，不能再代收',
        },
      }
    }
    const resolved = resolveAaParticipant(group.participants, raw)
    if (typeof resolved !== 'number') {
      return { deny: { kind: 'deny', code: resolved.code, reason: resolved.reason } }
    }
    const participant = group.participants[resolved]!
    if (participant.status === 'paid') {
      return {
        deny: {
          kind: 'deny',
          code: 'aa-participant-paid',
          reason: `${participant.name} 的份额已经收过`,
        },
      }
    }
    if (participant.status === 'declined' || participant.status === 'expired') {
      return {
        deny: {
          kind: 'deny',
          code: 'aa-participant-closed',
          reason: `${participant.name} 已${participant.status === 'declined' ? '拒绝' : '过期'}`,
        },
      }
    }
    return { amountCents: action === 'decline' ? 0 : participant.shareCents }
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error, 'tool-failed'), reason: reasonOf(error) } }
  }
}

/** `close` 的票前预览：只校验组存在且仍在 `collecting`（结束一个已收口的组没有意义）。 */
async function checkAaClose(
  deps: BankToolDeps,
  call: ToolCallLike,
  userId: string,
): Promise<{ readonly ok: true } | { readonly deny: DenyVerdict }> {
  try {
    const groupId = readOptionalString(call.args, 'groupId', 'aa_create')
    if (groupId === undefined) {
      return {
        deny: {
          kind: 'deny',
          code: 'tool-args-invalid',
          reason: 'aa_create.close 需要 groupId',
        },
      }
    }
    const group = await deps.core.getAa(bankIds.user(userId), groupId as AaGroupId)
    if (group === undefined) {
      return { deny: { kind: 'deny', code: 'aa-unknown', reason: `找不到 AA 组 ${groupId}` } }
    }
    if (group.status !== 'collecting') {
      return {
        deny: {
          kind: 'deny',
          code: 'aa-group-closed',
          reason: `AA 组状态为 ${group.status}，不能再结束`,
        },
      }
    }
    return { ok: true }
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error, 'tool-failed'), reason: reasonOf(error) } }
  }
}

/**
 * 参与人定位（票前预览用）：纯数字串按序号，其余按姓名精确匹配。
 *
 * **不把手机号当键**：它既不是姓名也不是序号，只会落到 `aa-participant-unknown`。
 */
function resolveAaParticipant(
  participants: readonly { readonly name: string }[],
  raw: string,
): number | { readonly code: string; readonly reason: string } {
  if (/^\d+$/.test(raw)) {
    const index = Number(raw)
    if (index >= participants.length) {
      return { code: 'aa-participant-unknown', reason: `AA 参与人序号越界：${raw}` }
    }
    return index
  }
  const name = raw.trim()
  if (name.length === 0) {
    return { code: 'aa-participant-unknown', reason: 'AA 参与人不能为空' }
  }
  const matches = participants
    .map((participant, index) => ({ participant, index }))
    .filter((item) => item.participant.name === name)
  if (matches.length === 0) {
    return { code: 'aa-participant-unknown', reason: `AA 组里没有参与人「${name}」` }
  }
  if (matches.length > 1) {
    return {
      code: 'aa-participant-ambiguous',
      reason: `AA 组里有 ${String(matches.length)} 位「${name}」，请改用序号`,
    }
  }
  return matches[0]!.index
}

/**
 * 顺序有意固定：金额边界（`below-minimum`）先于适当性。既有用例
 * `wealth.test.ts`「低于起投额」考的是金额边界，不该被适当性改写语义；
 * 反过来，适当性判断不依赖金额，后判不会漏拦。
 */
async function checkWealthPurchase(
  deps: BankToolDeps,
  call: ToolCallLike,
  userId: string,
): Promise<{ readonly amountCents: number } | { readonly deny: DenyVerdict }> {
  try {
    const amountCents = parsePurchaseAmount(call.args)
    const productId = readString(call.args, 'productId', 'wealth_purchase')
    const product = (await deps.core.listWealthProducts()).find((item) => item.id === productId)
    if (product === undefined) {
      return {
        deny: { kind: 'deny', code: 'product-unknown', reason: `未知理财产品 ${productId}` },
      }
    }
    if (amountCents < product.minAmountCents) {
      return {
        deny: {
          kind: 'deny',
          code: 'below-minimum',
          reason: `低于起投额（${product.minAmountCents} 分）`,
        },
      }
    }
    // 适当性读**客户主体**，不读会话、不读画像快照：等级的唯一权威在 core。
    const user = await deps.core.getUser(bankIds.user(userId))
    if (user === undefined) {
      return { deny: { kind: 'deny', code: 'user-unknown', reason: '当前用户不存在' } }
    }
    const verdict = checkSuitability({
      customerRisk: user.riskGrade,
      productRisk: product.riskGrade,
    })
    if (!verdict.allow) {
      return { deny: { kind: 'deny', code: verdict.code, reason: verdict.reason } }
    }
    return { amountCents }
  } catch (error) {
    // 参数错误自带 `tool-args-invalid`；取数失败（provider / 主体读取）不能伪装成参数错，
    // 否则审计上会把"系统故障"记成"模型传错参数"。
    return { deny: { kind: 'deny', code: errorCodeOf(error, 'tool-failed'), reason: reasonOf(error) } }
  }
}

/**
 * 赎回金额的**票前**解析：票据金额必须等于本次赎回额，否则 bank-core 的
 * `TicketStore.redeem` 会在执行时以 `ticket-binding-mismatch` 拒绝。
 *
 * `amountYuan` 缺省 = 全额赎回，所以不能在 spec 上用静态 `amountPath` 解决；
 * 必须在治理面读一次持仓（与工具 execute 读的是同一份 `listHoldings`）。
 */
async function checkWealthRedeem(
  deps: BankToolDeps,
  call: ToolCallLike,
  userId: string,
): Promise<{ readonly amountCents: number } | { readonly deny: DenyVerdict }> {
  try {
    const holdingId = readOptionalString(call.args, 'holdingId', 'wealth_redeem')
    const productId = readOptionalString(call.args, 'productId', 'wealth_redeem')
    if (holdingId === undefined && productId === undefined) {
      return {
        deny: {
          kind: 'deny',
          code: 'tool-args-invalid',
          reason: 'wealth_redeem 需要 holdingId 或 productId',
        },
      }
    }
    const holdings = await deps.core.listHoldings(bankIds.user(userId))
    const holding = holdings.find(
      (item) =>
        (holdingId !== undefined && item.id === holdingId) ||
        (holdingId === undefined && productId !== undefined && item.productId === productId),
    )
    if (holding === undefined) {
      return {
        deny: { kind: 'deny', code: 'holding-unknown', reason: '找不到可赎回的持仓' },
      }
    }
    const amountCents =
      call.args['amountYuan'] === undefined
        ? holding.marketValueCents
        : yuanToCents(readNumber(call.args, 'amountYuan', 'wealth_redeem'))
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return {
        deny: { kind: 'deny', code: 'holding-amount-invalid', reason: '赎回金额必须是正整数分' },
      }
    }
    if (amountCents > holding.marketValueCents) {
      return {
        deny: {
          kind: 'deny',
          code: 'holding-amount-invalid',
          reason: '赎回金额超过持仓市值',
        },
      }
    }
    return { amountCents }
  } catch (error) {
    return { deny: { kind: 'deny', code: errorCodeOf(error, 'tool-failed'), reason: reasonOf(error) } }
  }
}

/** 元 → 分（票据桥接；缺省金额按 0 处理，真正的金额校验在工具体）。 */
function centsOf(amount: number | undefined): number {
  return amount === undefined ? 0 : Math.round(amount * 100)
}

/** 调用 ID → 票据 ID（与管线 `mintTicket` 同一规则）。 */
function ticketIdOf(callId: string): TicketId {
  return `ticket:${callId}` as TicketId
}

/**
 * 票据记账的安全边界：账本异常绝不冒泡到业务路径（资金已动时尤其致命）。
 *
 * 失败降级为 `ticket/ledger-failed` 审计事件；审计通道本身也失败时只能放弃——
 * 但绝不允许因为它改写 `tool/result` 或审批结论。
 */
function ledgerSafely(
  deps: BankToolDeps,
  ticketId: string,
  op: 'issue' | 'approve' | 'redeem' | 'consume' | 'block',
  at: number,
  action: () => unknown,
): void {
  try {
    action()
  } catch (error) {
    reportLedgerFailure(deps, ticketId, op, at, error)
  }
}

function reportLedgerFailure(
  deps: BankToolDeps,
  ticketId: string,
  op: 'issue' | 'approve' | 'redeem' | 'consume' | 'block' | 'result',
  at: number,
  error: unknown,
): void {
  try {
    deps.audit.append('ticket/ledger-failed', {
      ticketId,
      op,
      code: errorCodeOf(error, 'tool-failed'),
      reason: reasonOf(error),
      at,
    })
  } catch {
    // 审计出口也失联：放弃记录，但绝不把异常抛回资金路径
  }
}
