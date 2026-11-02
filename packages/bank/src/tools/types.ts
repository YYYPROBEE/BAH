/**
 * 银行工具族的依赖注入面。
 *
 * 工具定义是**闭包**：创建时注入 `BankCoreProvider` / 票据库 / 审计出口 / 身份解析 /
 * 强验证服务。这样工具体不依赖 `ToolExecContext` 之外的隐藏单例，单测可替换任一依赖，
 * 运行时（host 插件）也能在不改工具代码的情况下换 mock / 真实银行。
 */

import type { SessionId } from '@bah/core'

import type { BankCoreProvider } from '../core/provider.ts'
import type { TicketStore } from '../core/ticket.ts'
import type { StrongAuth } from '../core/model.ts'
import type { VerifyService } from '../verify/index.ts'
import type { BankAudit } from './events.ts'

/** 工具族配置（随部署变化的取值；在 host 插件的 `validate` 里 fail-loud 校验）。 */
export interface BankToolsConfig {
  /** 理财风险提示 ID（前端强制渲染）。 */
  readonly disclaimerId: string
  /** `analysis_calc` 的执行上限（ms）；沙箱超时熔断。 */
  readonly computeTimeoutMs: number
  /** 审批票据 TTL（秒）——**审批超时与票据 TTL 同源**于这一个常量。 */
  readonly ticketTtlSeconds: number
  /** 红级操作的强验证渠道（09 会按用户/场景选择）。 */
  readonly redChallenge: StrongAuth
  /**
   * 日累计上限（**元**）。
   *
   * 生效值 = `min(core 账本的卡/账户日限额, 本值)`：数据只能收紧、不能放宽 Config。
   */
  readonly dailyTransferLimit: number
  /** 计入组合风险的工具名。 */
  readonly riskyOps: readonly string[]
  /** 同一 turn 内允许的风险调用次数；超过后非绿调用一律 `ask`。 */
  readonly riskyCallThreshold: number
  /**
   * 风险测评重测冷却（**天**；R-2）。
   *
   * 保守缺省 1 天：一次落档后，同一用户在冷却窗口内再提交会被核心拒
   * （`risk-retest-cooldown`），且不消耗新卷。演示可配 0 关闭。
   * 冷却判定在核心（`RiskQuestionnaireBook`），本配置只是把毫秒数交给装配方。
   */
  readonly riskCooldownDays: number
}

/** 身份解析接缝：09 落地为会话绑定；08 的 headless 由 profile 显式配置演示用户。 */
export interface BankIdentity {
  /** 会话 → 银行用户 ID；`undefined` = 未绑定（业务工具一律拒绝）。 */
  resolve(sessionId: SessionId): string | undefined
  /**
   * 会话 → 完整身份（用户 + 绑定时租户）。可选：只实现 `resolve` 的旧接缝仍可用，
   * 此时租户闸跳过（`wrong-tenant` 需要两边都有租户才判）。
   */
  resolveIdentity?(sessionId: SessionId): {
    readonly userId: string
    readonly tenantId?: string
  } | undefined
}

/** 受限计算请求。 */
export interface ComputeRequest {
  readonly code: string
  readonly data?: Readonly<Record<string, unknown>>
  /** 硬上限（工具层还会用 `Promise.race` 再兜一层超时）。 */
  readonly limits: {
    readonly timeoutMs: number
    readonly maxOperations: number
  }
}

/** 受限计算产出。 */
export interface ComputeResult {
  readonly value: number
  readonly operations: number
}

/** 受限计算接缝（默认实现见 `compute.ts`；11 的沙箱插件可整体替换）。 */
export type ComputeSeam = (request: ComputeRequest) => Promise<ComputeResult>

/** 工具族的全部依赖。 */
export interface BankToolDeps {
  readonly core: BankCoreProvider
  /** 票据库（核销属主；工具边界只组 `TicketRef`）。 */
  readonly tickets: TicketStore
  readonly audit: BankAudit
  readonly identity: BankIdentity
  readonly verify: VerifyService
  readonly config: BankToolsConfig
  /** 时钟（缺省 `Date.now`；测试与回放注入固定钟）。 */
  readonly now?: () => number
  /** 受限计算（缺省用本包的表达式求值器）。 */
  readonly compute?: ComputeSeam
}

/** 生效时钟。 */
export function clockOf(deps: BankToolDeps): () => number {
  return deps.now ?? (() => Date.now())
}
