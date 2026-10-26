/**
 * 冲正能力端口（W12）。
 *
 * 为什么单独开一个服务键而不是加一个工具：
 * - 工具目录是**冻结的 14 个**（W03/W12 红线），冲正是补偿面的内部动作，模型不可见；
 * - saga 插件不认识 `MockBankCore`，只通过窄端口调用；真实对接时换一个实现即可，
 *   调用方（host 的 saga-bridge）不需要改。
 *
 * 语义边界：本端口只做**账本冲正**（两条流水 + 余额回补），不是"撤销银行核心交易"。
 * Mock 提供幂等冲正语义；生产必须接银行核心的冲正/退款接口。
 */

import { defineService } from '@bah/core'

import type { TxnId } from './model.ts'

/** 冲正结果（幂等：同一 `txnId` 重复调用返回同一份结果）。 */
export interface ReversalResult {
  /** 原交易 ID（幂等键）。 */
  readonly txnId: TxnId
  /** 冲正流水 ID（原交易 + 冲正 = 两条流水，不删原记录）。 */
  readonly reversalTxnId: TxnId
  readonly amountCents: number
  readonly balanceCents: number
  readonly availableCents: number
  /** 回退后的当日已用额度（口径：当日净转出，见 `mock.ts`）。 */
  readonly dailyUsedCents: number
  readonly dailyLimitCents: number
  readonly at: number
}

/** 冲正端口（宿主装配；saga 补偿调用）。 */
export interface BankCompensationPort {
  /**
   * 冲正一笔转账（幂等键 = 原 `txnId`）。
   *
   * @throws `BahError('txn-unknown')` 原交易不存在
   * @throws `BahError('txn-not-reversible')` 不是成功的转出转账
   */
  reverse(txnId: string): Promise<ReversalResult>
  /** 查询某笔交易是否已冲正（探诊用；未冲正返回 `undefined`）。 */
  reversalOf(txnId: string): ReversalResult | undefined
}

/** 服务键：`bank:compensation`（窄端口，不含任何票据 / 审批入口）。 */
export const BANK_COMPENSATION = defineService<BankCompensationPort>('bank:compensation')
