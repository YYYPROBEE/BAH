/**
 * 银行工具族的依赖注入面（施工单 08 §1 的工具契约 + 07 的 Provider seam）。
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
  /** 理财风险提示 ID（施工单 08 §0 第 5 条：前端强制渲染）。 */
  readonly disclaimerId: string
  /** `analysis_calc` 的执行上限（ms）；沙箱超时熔断。 */
  readonly computeTimeoutMs: number
  /** 审批票据 TTL（秒）。 */
  readonly ticketTtlSeconds: number
  /** 红级操作的强验证渠道（09 会按用户/场景选择）。 */
  readonly redChallenge: StrongAuth
}

/** 身份解析接缝：09 落地为会话绑定；08 的 headless 由 profile 显式配置演示用户。 */
export interface BankIdentity {
  /** 会话 → 银行用户 ID；`undefined` = 未绑定（业务工具一律拒绝）。 */
  resolve(sessionId: SessionId): string | undefined
}

/** 受限计算请求（施工单 11 的 `compute-bounded` 档在 08 的可替换接缝）。 */
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
