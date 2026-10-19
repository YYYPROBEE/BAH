/**
 * 票据状态机与核销属主（施工单 07 §3）。
 *
 * ```text
 * issued(pending) ──批准──▶ approved(allowed-once) ──bank-core 执行──▶ redeemed(consumed)
 *      │                          │
 *      └──── 拒绝/超时/失败 ───────┴──▶ blocked
 * ```
 *
 * 三条铁律：
 * 1. **核销唯一属主 = bank-core**：`redeem()` 校验「已签发 + 已审批 + 未过期 + 未使用 + 五绑定一致」，
 *    通过后**同步**转 `redeemed`（单线程事件循环内先查后转，中间没有 await，天然防并发重放）。
 * 2. `tools/result` 侧只记账（成功 → consumed、失败 → blocked），不承担状态转移（施工单 09）。
 * 3. `TicketRef` 是**写入领域边界**的授权载体：模型绕过工具直连核心，也拿不到 approved 的票据。
 *
 * 五绑定（施工单 07 §3）：会话 / 工具 / 参数指纹 / 金额 / 时效 TTL。
 * 与 `@bah/core` 冻结的 `TicketRef`（只有 ticketId + 指纹 + 金额 + 过期时刻）的关系：
 * 会话与工具名由工具执行上下文补全（`ToolExecContext.sessionId` + 工具名），在施工单 08/09 的
 * 工具边界完成映射；本包的五绑定是核销时的**权威比对材料**。
 */

import { defineService } from '@bah/core'

import type { ServiceKey, SessionId, TicketId } from '@bah/core'

import { BahError } from '@bah/util'

/** 票据状态。 */
export type TicketStatus = 'issued' | 'approved' | 'redeemed' | 'blocked'

/** 五绑定：核销时必须逐项一致。 */
export interface TicketBinding {
  readonly sessionId: SessionId
  /** 工具名（模型可见名，如 `transfer_money`）。 */
  readonly tool: string
  /** 参数指纹：参数变化即失效。 */
  readonly fingerprint: string
  /** 本次涉及金额（分）；无金额工具缺省。 */
  readonly amountCents?: number
  /** 过期时刻（epoch ms）。 */
  readonly expiresAt: number
}

/** 写操作必须携带的票据引用（领域边界形状，施工单 07 §1）。 */
export interface TicketRef {
  readonly ticketId: TicketId
  readonly binding: TicketBinding
}

/** 票据记录（状态机内部真相）。 */
export interface TicketRecord {
  readonly ticketId: TicketId
  readonly binding: TicketBinding
  readonly status: TicketStatus
  readonly issuedAt: number
  readonly approvedAt?: number
  readonly redeemedAt?: number
  readonly blockedAt?: number
  readonly blockedReason?: string
}

/**
 * 内存票据库（mock 核心自带；真实对接时换成持久化实现，状态机语义不变）。
 *
 * 所有方法都是**同步**的：核销的 CAS 不允许在"检查"与"转移"之间穿插 await。
 */
export class TicketStore {
  private readonly records = new Map<string, TicketRecord>()

  /** 已登记票据数（运维 / 用例观察用）。 */
  get size(): number {
    return this.records.size
  }

  /**
   * 签发（`issued`）。由治理平面的 `ask` 判决调用（施工单 09）。
   *
   * @throws `ticket-duplicate` 同一票据 ID 重复签发
   * @throws `ticket-expired` 签发时就已经过期
   */
  issue(ticketId: TicketId, binding: TicketBinding, now: number): TicketRecord {
    if (this.records.has(ticketId)) {
      throw new BahError('ticket-duplicate', `bank: 票据重复签发：${ticketId}`, { ticketId })
    }
    if (binding.expiresAt <= now) {
      throw new BahError('ticket-expired', `bank: 票据签发时已过期：${ticketId}`, {
        ticketId,
        expiresAt: binding.expiresAt,
        now,
      })
    }
    const record: TicketRecord = { ticketId, binding, status: 'issued', issuedAt: now }
    this.records.set(ticketId, record)
    return record
  }

  /**
   * 用户批准（`issued → approved`）。
   *
   * 幂等：已批准直接返回；已核销 / 已阻断 → `ticket-closed`；过期 → 先置 `blocked` 再抛。
   *
   * @throws `ticket-unknown` / `ticket-closed` / `ticket-expired`
   */
  approve(ticketId: TicketId, now: number): TicketRecord {
    const record = this.require(ticketId)
    if (record.status === 'approved') return record
    if (record.status !== 'issued') {
      throw new BahError('ticket-closed', `bank: 票据已关闭（${record.status}），不能再批准：${ticketId}`, {
        ticketId,
        status: record.status,
      })
    }
    if (record.binding.expiresAt <= now) {
      this.records.set(ticketId, {
        ...record,
        status: 'blocked',
        blockedAt: now,
        blockedReason: 'expired',
      })
      throw new BahError('ticket-expired', `bank: 票据已过期：${ticketId}`, {
        ticketId,
        expiresAt: record.binding.expiresAt,
        now,
      })
    }
    const approved: TicketRecord = { ...record, status: 'approved', approvedAt: now }
    this.records.set(ticketId, approved)
    return approved
  }

  /**
   * 阻断（拒绝 / 超时 / 执行失败 / 过期）。
   *
   * 幂等；已核销的票据不可再阻断（核销是终态）。
   *
   * @throws `ticket-unknown` / `ticket-closed`
   */
  block(ticketId: TicketId, reason: string, now: number): TicketRecord {
    const record = this.require(ticketId)
    if (record.status === 'blocked') return record
    if (record.status === 'redeemed') {
      throw new BahError('ticket-closed', `bank: 票据已核销，不能再阻断：${ticketId}`, {
        ticketId,
        status: record.status,
      })
    }
    const blocked: TicketRecord = {
      ...record,
      status: 'blocked',
      blockedAt: now,
      blockedReason: reason,
    }
    this.records.set(ticketId, blocked)
    return blocked
  }

  /**
   * 核销（`approved → redeemed`）——**唯一属主**。
   *
   * 顺序即安全边界：未知 → 已核销 → 已阻断 → 未审批 → 已过期 → 绑定不一致 → 成功。
   * 失败一律不改变票据状态（除过期会顺手置 `blocked`），成功则同步转 `redeemed`。
   *
   * @throws `ticket-unknown` / `ticket-already-redeemed` / `ticket-blocked` /
   *   `ticket-not-approved` / `ticket-expired` / `ticket-binding-mismatch`
   */
  redeem(ref: TicketRef, now: number): TicketRecord {
    const record = this.require(ref.ticketId)
    if (record.status === 'redeemed') {
      throw new BahError(
        'ticket-already-redeemed',
        `bank: 票据已被核销（拒绝重放）：${ref.ticketId}`,
        { ticketId: ref.ticketId, redeemedAt: record.redeemedAt },
      )
    }
    if (record.status === 'blocked') {
      throw new BahError('ticket-blocked', `bank: 票据已被阻断：${ref.ticketId}`, {
        ticketId: ref.ticketId,
        reason: record.blockedReason,
      })
    }
    if (record.status !== 'approved') {
      throw new BahError('ticket-not-approved', `bank: 票据尚未审批：${ref.ticketId}`, {
        ticketId: ref.ticketId,
        status: record.status,
      })
    }
    if (record.binding.expiresAt <= now) {
      this.records.set(ref.ticketId, {
        ...record,
        status: 'blocked',
        blockedAt: now,
        blockedReason: 'expired',
      })
      throw new BahError('ticket-expired', `bank: 票据已过期：${ref.ticketId}`, {
        ticketId: ref.ticketId,
        expiresAt: record.binding.expiresAt,
        now,
      })
    }
    const differs = bindingDiff(record.binding, ref.binding)
    if (differs !== undefined) {
      throw new BahError(
        'ticket-binding-mismatch',
        `bank: 票据绑定不一致（${differs}）：${ref.ticketId}`,
        { ticketId: ref.ticketId, field: differs },
      )
    }
    // CAS：检查与转移之间没有 await（JS 单线程内原子）
    const redeemed: TicketRecord = { ...record, status: 'redeemed', redeemedAt: now }
    this.records.set(ref.ticketId, redeemed)
    return redeemed
  }

  /** 读取票据记录（不存在返回 `undefined`）。 */
  get(ticketId: TicketId): TicketRecord | undefined {
    return this.records.get(ticketId)
  }

  /** 读取票据状态（不存在返回 `undefined`）。 */
  status(ticketId: TicketId): TicketStatus | undefined {
    return this.records.get(ticketId)?.status
  }

  /**
   * 吊销全部**在途**票据（`issued` / `approved` → `blocked`）。
   *
   * 施工单 10 §5 的熔断动作：冻结时让旧票据不可执行。属主仍是本类——
   * 断路器只调用它，不自己改票据状态；`redeemed` / `blocked` 是终态，不受影响。
   *
   * @param reason 阻断理由（审计用；如 `sentry-breaker-frozen`）
   * @param now 操作时刻（epoch ms；注入时钟）
   * @returns 本次被吊销的票据记录（顺序 = 签发顺序）
   */
  revokeAll(reason: string, now: number): readonly TicketRecord[] {
    const revoked: TicketRecord[] = []
    for (const [ticketId, record] of this.records) {
      if (record.status !== 'issued' && record.status !== 'approved') continue
      const blocked: TicketRecord = {
        ...record,
        status: 'blocked',
        blockedAt: now,
        blockedReason: reason,
      }
      this.records.set(ticketId, blocked)
      revoked.push(blocked)
    }
    return revoked
  }

  private require(ticketId: TicketId): TicketRecord {
    const record = this.records.get(ticketId)
    if (record === undefined) {
      throw new BahError('ticket-unknown', `bank: 未知票据：${ticketId}`, { ticketId })
    }
    return record
  }
}

/**
 * 服务键：`bank:tickets`（票据状态机的宿主出口）。
 *
 * 只暴露**状态读取 + 批量吊销**这一对最小面：核销仍只在工具体内经 `TicketRef` 完成，
 * 安全层拿不到 `redeem()` 的授权入口（施工单 07 §3：核销唯一属主）。
 */
export const BANK_TICKETS: ServiceKey<TicketStore> = defineService<TicketStore>('bank:tickets')

/** 五绑定逐项比对；返回第一处不一致的字段名，全等返回 `undefined`。 */function bindingDiff(left: TicketBinding, right: TicketBinding): string | undefined {
  if (left.sessionId !== right.sessionId) return 'sessionId'
  if (left.tool !== right.tool) return 'tool'
  if (left.fingerprint !== right.fingerprint) return 'fingerprint'
  if (left.amountCents !== right.amountCents) return 'amountCents'
  if (left.expiresAt !== right.expiresAt) return 'expiresAt'
  return undefined
}
