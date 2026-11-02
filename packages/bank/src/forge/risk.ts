/**
 * mock 侧风控预检：与 Harness 侧判决**互为冗余**。
 *
 * 这里给的是业务解释（余额、日限额、收款人、夜间大额、短时高频），不是最终裁决——
 * 最终 ask / deny 由治理平面按工具 tier 决定。核心多一道预检的意义：
 * 模型能拿到"为什么这笔会被拦"的结构化理由，而不是只看到审批弹窗。
 */

import type { PayeeBinding, BankLimits, CardStatus } from '../core/model.ts'
import { CN_TZ_OFFSET_MS } from '../core/model.ts'
import type { RiskFinding } from '../core/provider.ts'

/** 一次转账预检的输入（全部是权威口径：余额与日累计来自账本）。 */
export interface TransferRiskInput {
  readonly amountCents: number
  readonly availableCents: number
  /** 当日已累计转出（分）。 */
  readonly dailyUsedCents: number
  readonly dailyLimitCents: number
  /** 收款人绑定关系（未登记过 = `new`）。 */
  readonly payeeBinding: PayeeBinding
  /** 短时窗口内已成功的转出笔数（不含本笔）。 */
  readonly recentOutCount: number
  /** 2 分钟内同收款人同金额的成功转出（疑似重复提交；只告警不阻断）。 */
  readonly duplicateRecent?: boolean
  /** 发生时刻（epoch ms）。 */
  readonly at: number
  readonly limits: BankLimits
  /** 本笔以哪张卡支付时的卡状态（未指定 `viaCardId` 时不出现）。 */
  readonly cardStatus?: CardStatus
  /** 该卡尾号（仅用于可读理由，不参与判定）。 */
  readonly cardTail?: string
}

/**
 * 预检规则（顺序固定，便于审计对表）。
 *
 * 级别约定：余额不足 / 超日限额 = `block`；收款人异常 / 夜间大额 / 短时高频 / 疑似重复 = `warn`
 * （升级为 deny 的权力在治理平面，核心不替它做决定）。
 */
export function checkTransferRisks(input: TransferRiskInput): RiskFinding[] {
  const findings: RiskFinding[] = []

  // 卡状态是最前置的硬约束：卡已冻结/挂失时，讨论余额与额度都没有意义。
  if (input.cardStatus !== undefined && input.cardStatus !== 'normal') {
    findings.push({
      rule: 'card-status',
      severity: 'block',
      code: 'card-unavailable',
      message:
        input.cardStatus === 'lost'
          ? `尾号 ${input.cardTail ?? ''} 的卡已挂失，不能用于支付`
          : `尾号 ${input.cardTail ?? ''} 的卡已冻结，请先解冻`,
      detail: { cardStatus: input.cardStatus },
    })
  }

  if (input.amountCents > input.availableCents) {
    findings.push({
      rule: 'insufficient-balance',
      severity: 'block',
      code: 'insufficient-balance',
      message: `余额不足：可用 ${input.availableCents} 分，本笔 ${input.amountCents} 分`,
      detail: { availableCents: input.availableCents, amountCents: input.amountCents },
    })
  }

  const remainingCents = Math.max(0, input.dailyLimitCents - input.dailyUsedCents)
  if (input.dailyUsedCents + input.amountCents > input.dailyLimitCents) {
    findings.push({
      rule: 'daily-limit',
      // 与执行侧同语义：日限额不放行"静默通过"，而是强制升红走人工审批（治理平面决定 ask/deny）
      severity: 'warn',
      code: 'daily-limit-exceeded',
      message: `超出当日转账额度：已用 ${input.dailyUsedCents} 分，剩余 ${remainingCents} 分（需人工审批）`,
      detail: {
        dailyUsedCents: input.dailyUsedCents,
        dailyLimitCents: input.dailyLimitCents,
        remainingCents,
      },
    })
  }

  if (input.payeeBinding === 'new') {
    findings.push({
      rule: 'payee',
      severity: 'warn',
      code: 'payee-new',
      message: '新收款人：首次向该收款人转账，需人工确认',
    })
  }

  if (input.duplicateRecent === true) {
    findings.push({
      rule: 'duplicate',
      severity: 'warn',
      code: 'duplicate-transfer',
      message: '疑似重复转账：2 分钟内向同一收款人转过相同金额，请确认不是重复提交',
    })
  }

  if (isNight(input.at, input.limits) && input.amountCents >= input.limits.nightLargeCents) {
    findings.push({
      rule: 'night-amount',
      severity: 'warn',
      code: 'night-large-amount',
      message: `夜间大额：${input.amountCents} 分 ≥ 阈值 ${input.limits.nightLargeCents} 分`,
      detail: {
        amountCents: input.amountCents,
        thresholdCents: input.limits.nightLargeCents,
        hour: chinaHour(input.at),
      },
    })
  }

  if (input.recentOutCount >= input.limits.velocityMaxCount) {
    findings.push({
      rule: 'velocity',
      severity: 'warn',
      code: 'velocity-high',
      message: `短时高频：${input.limits.velocityWindowMs} ms 内已成功转出 ${input.recentOutCount} 笔`,
      detail: {
        recentOutCount: input.recentOutCount,
        maxCount: input.limits.velocityMaxCount,
        windowMs: input.limits.velocityWindowMs,
      },
    })
  }

  return findings
}

/** 是否落在夜间时段（支持跨零点，如 22 → 6）。 */
export function isNight(at: number, limits: BankLimits): boolean {
  const hour = chinaHour(at)
  const { nightStartHour: start, nightEndHour: end } = limits
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/**
 * 固定东八区的小时（0–23）。
 *
 * 为什么不看运行机器的本地时区：夜间大额判定必须**跨机器一致**，否则同一笔在 CI 与开发机
 * 上判决不同，快照回放也会飘。演示场景固定中国时区，这里直接按 UTC+8 算。
 */
function chinaHour(at: number): number {
  return new Date(at + CN_TZ_OFFSET_MS).getUTCHours()
}
