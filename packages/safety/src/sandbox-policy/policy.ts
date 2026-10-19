/**
 * 沙箱档位解析（施工单 11 §2）。
 *
 * 解析是**按调用**的，三层输入按"后层只能覆盖前层的结果"叠合：
 *
 * ```text
 * 默认档（工具声明 / Config）← 会话 override（只收紧）← 显式批准档（可放宽，上限 compute-bounded）
 * ```
 *
 * 两条恒等规则（不可配置，违反即抛）：
 * 1. **模型生成的代码一律不得进入 `none`**——`none` 不经 worker，没有 `resourceLimits`
 *    与硬杀，等于把模型代码放进宿主进程（§2 硬规则）；
 * 2. **会话 override 只能收紧**——放宽必须走显式批准（人签过的票据），不能靠配置悄悄放宽。
 */

import { BahError } from '@bah/util'

import type { SandboxTier, TierSpec } from './tier.ts'
import { DEFAULT_TIER_SPECS, isWider } from './tier.ts'

/** 一次待解析的工具调用（`codeSource` 是硬规则的判据）。 */
export interface SandboxCall {
  /** 工具名（与模型可见名一致）。 */
  readonly tool: string
  /** 待执行内容的来源：`model` = 模型生成（一律禁入 `none`）；`trusted` = 仓内代码。 */
  readonly codeSource: 'model' | 'trusted'
  /** 本次调用的参数指纹（显式批准档按指纹绑定；缺省表示本调用不接受批准）。 */
  readonly fingerprint?: string
}

/** 解析结论：档位 + 生效限制 + 可审计的"为什么是这一档"。 */
export interface SandboxDecision {
  readonly tool: string
  readonly tier: SandboxTier
  readonly limits: TierSpec
  readonly codeSource: 'model' | 'trusted'
  /** 相对默认档收紧了（会话 override 生效）。 */
  readonly narrowed?: SandboxTier
  /** 相对默认档放宽了（显式批准生效；`none` 永不出现在这里，除非调用本身是 trusted）。 */
  readonly granted?: SandboxTier
}

/** 会话级收紧记录（`override`）。 */
interface SessionOverride {
  readonly tier: SandboxTier
  readonly reason: string
}

/** 显式批准记录：绑定到具体一次调用的指纹，带时效。 */
interface ApprovalGrant {
  readonly fingerprint: string
  readonly tier: SandboxTier
  readonly expiresAt: number
}

/** 一个会话的沙箱状态（只收紧的 override + 在途批准）。 */
export interface SandboxSessionState {
  readonly overrides: Map<string, SessionOverride>
  /** 在途批准（一次性消费；过期条目在下一次命中时清扫）。 */
  grants: ApprovalGrant[]
}

/** 构造参数（全部由宿主从 Config 解析后注入）。 */
export interface SandboxPolicyOptions {
  /** 工具名 → 默认档（未列出的工具走 `fallbackTier`）。 */
  readonly defaults?: Readonly<Record<string, SandboxTier>>
  /** 未声明工具的兜底档（缺省最严：`query-only`）。 */
  readonly fallbackTier?: SandboxTier
  /** 档位规格（缺省 `DEFAULT_TIER_SPECS`；Config 只能收紧数值）。 */
  readonly specs?: Readonly<Record<SandboxTier, TierSpec>>
  /** 时钟（测试与回放注入固定钟）。 */
  readonly now?: () => number
}

export class SandboxPolicy {
  private readonly defaults: Readonly<Record<string, SandboxTier>>
  private readonly fallbackTier: SandboxTier
  private readonly specs: Readonly<Record<SandboxTier, TierSpec>>
  private readonly now: () => number
  private readonly sessions = new Map<string, SandboxSessionState>()

  constructor(options: SandboxPolicyOptions = {}) {
    this.defaults = { ...(options.defaults ?? {}) }
    this.fallbackTier = options.fallbackTier ?? 'query-only'
    this.specs = options.specs ?? DEFAULT_TIER_SPECS
    this.now = options.now ?? (() => Date.now())
    // 档位表缺项 = 装配错误：宁可载入即抛，不要在判决时才想起少配了一档
    for (const tier of [this.fallbackTier, ...Object.values(this.defaults)]) {
      if (this.specs[tier] === undefined) {
        throw sandboxError('tier-unknown', `档位 ${tier} 没有规格（policy 构造期）`)
      }
    }
  }

  /**
   * 解析一次调用应该进哪一档。
   *
   * @throws `bah-sandbox: model-code-to-none` 模型代码被解析到 `none`（硬规则 1）
   */
  resolve(call: SandboxCall, sessionId: string): SandboxDecision {
    const base = this.baseTierOf(call.tool)
    const override = this.sessions.get(sessionId)?.overrides.get(call.tool)
    // 规则 2：override 只收紧；放宽一律拒绝（要放宽就走 grant）
    if (override !== undefined && isWider(override.tier, base)) {
      throw sandboxError(
        'override-widens',
        `会话 override 不能放宽档位：${call.tool} 默认 ${base}，override ${override.tier}`,
        { tool: call.tool, base, override: override.tier },
      )
    }
    const narrowed = override !== undefined && override.tier !== base ? override.tier : undefined
    const current = narrowed ?? base

    const grant = this.takeGrant(sessionId, call)
    const tier = grant ?? current
    if (call.codeSource === 'model' && tier === 'none') {
      throw sandboxError(
        'model-code-to-none',
        `模型生成的代码禁止进入 none 档（工具 ${call.tool}）`,
        { tool: call.tool, resolvedFrom: grant !== undefined ? 'grant' : current },
      )
    }
    const limits = this.specs[tier]
    if (limits === undefined) throw sandboxError('tier-unknown', `档位 ${tier} 没有规格`)

    return {
      tool: call.tool,
      tier,
      limits,
      codeSource: call.codeSource,
      ...(narrowed === undefined ? {} : { narrowed }),
      ...(grant === undefined ? {} : { granted: grant }),
    }
  }

  /**
   * 会话级收紧（渠道"本次会话只允许只读计算"这类降权）。
   *
   * @throws `bah-sandbox: override-widens` 试图放宽
   */
  override(sessionId: string, tool: string, tier: SandboxTier, reason: string): void {
    const base = this.baseTierOf(tool)
    if (isWider(tier, base)) {
      throw sandboxError(
        'override-widens',
        `会话 override 不能放宽档位：${tool} 默认 ${base}，请求 ${tier}`,
        { tool, base, override: tier },
      )
    }
    this.stateOf(sessionId).overrides.set(tool, { tier, reason })
  }

  /** 取消会话级收紧（回到默认档；不删批准）。 */
  clearOverride(sessionId: string, tool: string): void {
    this.stateOf(sessionId).overrides.delete(tool)
  }

  /**
   * 记一次显式批准（票据已核销的那个调用允许放宽到 `tier`）。
   *
   * 批准档的上限是 `compute-bounded`：`none` 不经隔离，任何批准都不该买到它。
   *
   * @throws `bah-sandbox: grant-tier-invalid` 批准到 `none`
   */
  grant(
    sessionId: string,
    fingerprint: string,
    tier: SandboxTier,
    ttlMs: number,
  ): void {
    if (tier === 'none') {
      throw sandboxError('grant-tier-invalid', '显式批准不得放宽到 none 档', { tier })
    }
    this.stateOf(sessionId).grants.push({ fingerprint, tier, expiresAt: this.now() + ttlMs })
  }

  /** 清掉一个会话的全部沙箱状态（会话关闭 / dispose）。 */
  release(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** 当前生效的默认档（门禁与 `dump-config` 用）。 */
  baseTierOf(tool: string): SandboxTier {
    return this.defaults[tool] ?? this.fallbackTier
  }

  /** 某工具在给定会话下的生效档位表（审计面板用；不做解析，只报现状）。 */
  viewOf(sessionId: string): Readonly<Record<string, SandboxTier>> {
    const state = this.sessions.get(sessionId)
    const view: Record<string, SandboxTier> = {}
    for (const tool of Object.keys(this.defaults)) view[tool] = this.baseTierOf(tool)
    if (state !== undefined) {
      for (const [tool, override] of state.overrides) view[tool] = override.tier
    }
    return view
  }

  /** 取用并消费一条未过期批准（一次性；与票据的单次核销语义同构）。 */
  private takeGrant(sessionId: string, call: SandboxCall): SandboxTier | undefined {
    const state = this.sessions.get(sessionId)
    if (state === undefined || call.fingerprint === undefined) return undefined
    // 先清扫过期条目再做匹配：批准表不会因未命中的调用而无界增长
    const deadline = this.now()
    state.grants = state.grants.filter((grant) => grant.expiresAt > deadline)
    const index = state.grants.findIndex((grant) => grant.fingerprint === call.fingerprint)
    if (index < 0) return undefined
    const grant = state.grants[index] as ApprovalGrant
    state.grants.splice(index, 1)
    return grant.tier
  }

  private stateOf(sessionId: string): SandboxSessionState {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SandboxSessionState = { overrides: new Map(), grants: [] }
    this.sessions.set(sessionId, created)
    return created
  }
}

/** 带 `bah-sandbox: ` 前缀的结构化错误（施工单 11 §2 fail-loud）。 */
export function sandboxError(code: string, message: string, detail?: unknown): BahError {
  return new BahError(code, `bah-sandbox: ${message}`, detail)
}
