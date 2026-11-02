/**
 * 追问（选择题）的类型契约。
 *
 * 与本包 `approval/` 的分工：审批是治理面（票据、核销、`approval/decided`），
 * 追问只是「把一个问题问清楚」，点选结果是一条普通用户消息（D6）。
 */

/** 选择题候选项。label 是给人看的（点选后作为 user/message 原文发回）；value 是给机器消费的。 */
export interface PromptChoice {
  /** ≤20 字、禁控制字符（candidates.ts 校验，fail-loud）。 */
  readonly label: string
  /** 结构化值；账户类只允许尾号形态（PII 纪律随证据口径）。 */
  readonly value: string
  /** manual 恒为最后一项：「手动输入」出口。 */
  readonly kind: 'candidate' | 'manual'
}

export interface PromptRequest {
  readonly question: string
  /** 业务候选 ≤ MAX_CANDIDATES(3)，另固定追加 1 项手动输入 ⇒ choices.length ≤ 4。 */
  readonly choices: readonly PromptChoice[]
  /** 恒 true：必须留「不选，直接说别的」出口。 */
  readonly allowFreeText: boolean
  /** 追问目标槽位名，供前端展示与审计对照。 */
  readonly context?: string
}

export interface PromptResult {
  readonly question: string
  readonly choices: readonly PromptChoice[]
  readonly allowFreeText: boolean
  /** true = 候选为空 fail-loud 后降级成的开放式提问（不硬猜候选）。 */
  readonly degraded: boolean
  /** true = 同槽位追问已达上限，本次是最后的开放式提问。 */
  readonly askExhausted: boolean
}

/** 原始候选（来自记忆检索/账户列表）。 */
export interface CandidateInput {
  readonly label: string
  readonly value: string
}
