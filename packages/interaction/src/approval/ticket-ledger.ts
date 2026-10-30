/**
 * 票据生命周期账本（施工单 09 §3；从 `bank/src/tools/governance.ts` 的内存 `pending` Map 迁来）。
 *
 * 三步分工，谁都不越界：
 * 1. **bank-core** 仍是核销唯一属主（`TicketStore.redeem()` 的同步 CAS）；
 * 2. **本账本**只做「状态转移 + 审计投影」：转移合法性在这里 fail-loud，
 *    每次真实转移落一条 `ticket/*` 会话事件（可回放、可导出）；
 * 3. 判定与应答仲裁在 `approval/` 的其余模块。
 *
 * 为什么账本不自己读时钟：时间必须由调用方注入（插件线 09 硬约束 7），
 * 这样「TTL 先于审批超时」这类先后顺序才能由测试确定性地钉住。
 */

import { BahError } from '@bah/util'

import type { InteractionRecord, InteractionRecordSink } from './events.ts'
import type { AuthorizationRef } from './types.ts'

/** 票据生命周期状态（比 bank-core 的票据状态多一个 `consumed` 终态）。 */
export type TicketLifecycleStatus = 'issued' | 'approved' | 'redeemed' | 'consumed' | 'blocked'

/** 账本里的一条票据（审计投影；不替代 bank-core 的权威记录）。 */
export interface TicketLedgerEntry {
  /** 票据 ID。 */
  readonly ticketId: string
  /** 调用 ID。 */
  readonly callId: string
  /** 工具名。 */
  readonly name: string
  /** 参数指纹（参数变化即失效）。 */
  readonly fingerprint: string
  /** 金额（分）。 */
  readonly amountCents?: number
  /** 过期时刻（epoch ms）——同时是审批超时的截止时刻（同源于 `ticketTtlSeconds`）。 */
  readonly expiresAt: number
  /** 执行 lease 的 ID（W12；宿主注入，缺省 = 无 lease、行为与旧版完全一致）。 */
  readonly leaseId?: string
  /** 执行 lease 的到期时刻（epoch ms）；**必须 ≤ `expiresAt`**。 */
  readonly leaseExpiresAt?: number
  /** 当前状态。 */
  readonly status: TicketLifecycleStatus
  /** 签发时刻。 */
  readonly issuedAt: number
  /** 批准时刻。 */
  readonly approvedAt?: number
  /** 核销时刻。 */
  readonly redeemedAt?: number
  /** 消费时刻。 */
  readonly consumedAt?: number
  /** 阻断时刻。 */
  readonly blockedAt?: number
  /** 阻断理由（结构化理由码）。 */
  readonly blockedReason?: string
}

/** `issue()` 的输入。 */
export interface TicketIssueInput {
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  readonly fingerprint: string
  readonly amountCents?: number
  readonly expiresAt: number
  /**
   * 执行 lease（W12；由宿主随票据一起注入）。
   *
   * 结构内联而不是命名类型：`interaction` 不 import `@bah/runtime`（TC-W12-10），
   * 也不在本包再声明一份 `TicketLease`（那会成为第二个真相源）。
   */
  readonly lease?: {
    readonly leaseId: string
    readonly expiresAt: number
  }
  /** 授权来源（ADR-0008；缺省 = 人工点击）。 */
  readonly authorization?: AuthorizationRef
  /** 签发时刻。 */
  readonly at: number
}

/** `TicketLedger` 的装配参数。 */
export interface TicketLedgerOptions {
  /** 审计出口（缺省 = 只记内存，不落事件；单测与纯逻辑场景用）。 */
  readonly record?: InteractionRecordSink
}

/**
 * 票据生命周期账本（同步、无 IO）。
 *
 * 转移规则：
 * ```text
 * issued ──approve──▶ approved ──redeem──▶ redeemed ──consume──▶ consumed
 *    │                    │                   │
 *    └──────────── block ─┴───────────────────┘──▶ blocked（consume 后的票据不能再阻断）
 * ```
 * 重复的同向转移是**幂等 no-op**（重复应答 / 重复收尾很常见，不该炸）；
 * 反向或越级转移一律 `ticket-closed` / `ticket-not-approved`——那是程序错了，必须响。
 */
export class TicketLedger {
  private readonly records = new Map<string, TicketLedgerEntry>()
  /** callId → ticketId 反向索引（`forCall` 是收尾热路径，不能每次全表扫）。 */
  private readonly byCall = new Map<string, string>()
  private readonly record: InteractionRecordSink | undefined

  /** 账本软上限：超过后清理终态 / 过期票据（活动票据永不丢弃）。 */
  private static readonly MAX_RECORDS = 2048

  constructor(options: TicketLedgerOptions = {}) {
    this.record = options.record
  }

  /** 已登记票据数（运维 / 用例观察用）。 */
  get size(): number {
    return this.records.size
  }

  /**
   * 签发（`issued`）。
   *
   * @throws `BahError('ticket-duplicate')` 同一票据重复签发
   */
  issue(input: TicketIssueInput): TicketLedgerEntry {
    if (this.records.has(input.ticketId)) {
      throw new BahError('ticket-duplicate', `interaction: 票据重复签发：${input.ticketId}`, {
        ticketId: input.ticketId,
      })
    }
    if (input.lease !== undefined) this.assertLeaseFitsTicket(input)
    this.prune(input.at)
    const entry: TicketLedgerEntry = {
      ticketId: input.ticketId,
      callId: input.callId,
      name: input.name,
      fingerprint: input.fingerprint,
      ...(input.amountCents === undefined ? {} : { amountCents: input.amountCents }),
      expiresAt: input.expiresAt,
      ...(input.lease === undefined
        ? {}
        : { leaseId: input.lease.leaseId, leaseExpiresAt: input.lease.expiresAt }),
      status: 'issued',
      issuedAt: input.at,
    }
    this.records.set(entry.ticketId, entry)
    // 一个调用最多一张票据：保留先签发者，避免后来的重复调用改写映射
    if (!this.byCall.has(entry.callId)) this.byCall.set(entry.callId, entry.ticketId)
    this.record?.({
      type: 'ticket/issued',
      data: {
        ticketId: entry.ticketId,
        callId: entry.callId,
        name: entry.name,
        fingerprint: entry.fingerprint,
        ...(entry.amountCents === undefined ? {} : { amountCents: entry.amountCents }),
        expiresAt: entry.expiresAt,
        ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
        at: input.at,
      },
    })
    return entry
  }

  /**
   * 续租执行 lease（`leaseId` 不变，只前移到期时刻）。
   *
   * @throws `BahError('lease-missing')` 该票据没有 lease（未注入）
   * @throws `BahError('ticket-unknown')` / `BahError('ticket-closed')`
   * @throws `BahError('ticket-expired')` lease 已过期（不重签）
   * @throws `BahError('lease-renew-invalid')` 新到期时刻未前移
   * @throws `BahError('lease-outlives-ticket')` 越过票据 TTL
   */
  renewLease(ticketId: string, expiresAt: number, at: number): TicketLedgerEntry {
    const entry = this.require(ticketId)
    if (entry.leaseExpiresAt === undefined || entry.leaseId === undefined) {
      throw new BahError('lease-missing', `interaction: 票据没有执行 lease：${ticketId}`, {
        ticketId,
      })
    }
    if (entry.status === 'redeemed' || entry.status === 'consumed' || entry.status === 'blocked') {
      throw this.closed(entry, 'renew')
    }
    if (at >= entry.leaseExpiresAt) {
      this.block(ticketId, 'ticket-expired', at)
      throw new BahError('ticket-expired', `interaction: lease 已过期：${ticketId}`, {
        ticketId,
        leaseId: entry.leaseId,
        expiresAt: entry.leaseExpiresAt,
        now: at,
      })
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= entry.leaseExpiresAt) {
      throw new BahError(
        'lease-renew-invalid',
        `interaction: 续租只能前移（${String(expiresAt)} <= ${String(entry.leaseExpiresAt)}）：${ticketId}`,
        { ticketId, expiresAt, current: entry.leaseExpiresAt },
      )
    }
    if (expiresAt > entry.expiresAt) {
      throw new BahError(
        'lease-outlives-ticket',
        `interaction: lease(${String(expiresAt)}) 晚于票据 TTL(${String(entry.expiresAt)})：${ticketId}`,
        { ticketId, expiresAt, ticketExpiresAt: entry.expiresAt },
      )
    }
    const previousExpiresAt = entry.leaseExpiresAt
    return this.transition(entry, { leaseExpiresAt: expiresAt }, (next) => ({
      type: 'ticket/lease-renewed',
      data: {
        ticketId: next.ticketId,
        callId: next.callId,
        name: next.name,
        leaseId: entry.leaseId as string,
        previousExpiresAt,
        expiresAt,
        at,
      },
    }))
  }

  /**
   * 批准（`issued → approved`）。
   *
   * `authorization` 缺省 = 人工签署（ADR-0008：老调用方零改动）。
   *
   * @throws `BahError('ticket-unknown')` / `BahError('ticket-closed')`
   */
  approve(ticketId: string, at: number, authorization?: AuthorizationRef): TicketLedgerEntry {
    const entry = this.require(ticketId)
    if (entry.status === 'approved') return entry
    if (entry.status !== 'issued') throw this.closed(entry, 'approve')
    return this.transition(entry, { status: 'approved', approvedAt: at }, (next) => ({
      type: 'ticket/approved',
      data: {
        ticketId: next.ticketId,
        callId: next.callId,
        name: next.name,
        ...(authorization === undefined ? {} : { authorization }),
        at,
      },
    }))
  }

  /**
   * 核销（`approved → redeemed`）——**观察** bank-core 的核销结果，不是自己核销。
   *
   * @throws `BahError('ticket-unknown')` / `BahError('ticket-not-approved')` / `BahError('ticket-closed')`
   */
  redeem(ticketId: string, at: number): TicketLedgerEntry {
    const entry = this.require(ticketId)
    if (entry.status === 'redeemed') return entry
    if (entry.status === 'issued') {
      throw new BahError('ticket-not-approved', `interaction: 票据尚未审批，不能核销：${ticketId}`, {
        ticketId,
        status: entry.status,
      })
    }
    if (entry.status !== 'approved') throw this.closed(entry, 'redeem')
    // W12：lease 是比票据 TTL 更紧的窗口；过期即作废，不重签、不放行。
    if (entry.leaseExpiresAt !== undefined && at >= entry.leaseExpiresAt) {
      this.block(ticketId, 'ticket-expired', at)
      throw new BahError('ticket-expired', `interaction: 票据 lease 已过期：${ticketId}`, {
        ticketId,
        leaseId: entry.leaseId,
        expiresAt: entry.leaseExpiresAt,
        now: at,
      })
    }
    return this.transition(entry, { status: 'redeemed', redeemedAt: at }, (next) => ({
      type: 'ticket/redeemed',
      data: { ticketId: next.ticketId, callId: next.callId, name: next.name, at },
    }))
  }

  /**
   * 消费（`redeemed → consumed`：核销且调用成功）。
   *
   * @throws `BahError('ticket-unknown')` / `BahError('ticket-closed')`
   */
  consume(ticketId: string, at: number): TicketLedgerEntry {
    const entry = this.require(ticketId)
    if (entry.status === 'consumed') return entry
    if (entry.status !== 'redeemed') throw this.closed(entry, 'consume')
    return this.transition(entry, { status: 'consumed', consumedAt: at }, (next) => ({
      type: 'ticket/consumed',
      data: { ticketId: next.ticketId, callId: next.callId, name: next.name, at },
    }))
  }

  /**
   * 阻断（任意非终态 → `blocked`：拒绝 / 超时 / 过期 / 执行失败）。
   *
   * @throws `BahError('ticket-unknown')` / `BahError('ticket-closed')` 已消费的票据不可再阻断
   */
  block(ticketId: string, reason: string, at: number): TicketLedgerEntry {
    const entry = this.require(ticketId)
    if (entry.status === 'blocked') return entry
    if (entry.status === 'consumed') throw this.closed(entry, 'block')
    return this.transition(entry, { status: 'blocked', blockedAt: at, blockedReason: reason }, (next) => ({
      type: 'ticket/blocked',
      data: { ticketId: next.ticketId, callId: next.callId, name: next.name, reason, at },
    }))
  }

  /** 读取票据（不存在返回 `undefined`）。 */
  get(ticketId: string): TicketLedgerEntry | undefined {
    return this.records.get(ticketId)
  }

  /** 超上限时清理终态 / 过期票据；活动票据不丢。 */
  private prune(now: number): void {
    if (this.records.size < TicketLedger.MAX_RECORDS) return
    for (const [ticketId, entry] of this.records) {
      const terminal = entry.status === 'consumed' || entry.status === 'blocked'
      if (!terminal && entry.expiresAt > now) continue
      this.records.delete(ticketId)
      if (this.byCall.get(entry.callId) === ticketId) this.byCall.delete(entry.callId)
      if (this.records.size < TicketLedger.MAX_RECORDS / 2) break
    }
  }

  /** 按调用 ID 读取票据（一个调用最多一张票据）。 */
  forCall(callId: string): TicketLedgerEntry | undefined {
    const ticketId = this.byCall.get(callId)
    return ticketId === undefined ? undefined : this.records.get(ticketId)
  }

  /** 全量只读视图（审计导出用；顺序 = 签发顺序）。 */
  entries(): readonly TicketLedgerEntry[] {
    return [...this.records.values()]
  }

  private transition(
    entry: TicketLedgerEntry,
    patch: Partial<TicketLedgerEntry>,
    record: (next: TicketLedgerEntry) => InteractionRecord,
  ): TicketLedgerEntry {
    const next: TicketLedgerEntry = { ...entry, ...patch }
    this.records.set(next.ticketId, next)
    this.record?.(record(next))
    return next
  }

  private require(ticketId: string): TicketLedgerEntry {
    const entry = this.records.get(ticketId)
    if (entry === undefined) {
      throw new BahError('ticket-unknown', `interaction: 未知票据：${ticketId}`, { ticketId })
    }
    return entry
  }

  /** 签发期 lease 校验：窗口必须为正、不越过票据 TTL（TC-W12-09 的账本侧）。 */
  private assertLeaseFitsTicket(input: TicketIssueInput): void {
    const lease = input.lease
    if (lease === undefined) return
    if (typeof lease.leaseId !== 'string' || lease.leaseId.trim().length === 0) {
      throw new BahError('lease-invalid', `interaction: leaseId 非法：${input.ticketId}`, {
        ticketId: input.ticketId,
        leaseId: lease.leaseId,
      })
    }
    if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= input.at) {
      throw new BahError('lease-invalid', `interaction: lease 签发即过期：${input.ticketId}`, {
        ticketId: input.ticketId,
        expiresAt: lease.expiresAt,
        at: input.at,
      })
    }
    if (lease.expiresAt > input.expiresAt) {
      throw new BahError(
        'lease-outlives-ticket',
        `interaction: lease(${String(lease.expiresAt)}) 晚于票据 TTL(${String(input.expiresAt)})：${input.ticketId}`,
        { ticketId: input.ticketId, expiresAt: lease.expiresAt, ticketExpiresAt: input.expiresAt },
      )
    }
  }

  private closed(entry: TicketLedgerEntry, action: string): BahError {
    return new BahError(
      'ticket-closed',
      `interaction: 票据已关闭（${entry.status}），不能再 ${action}：${entry.ticketId}`,
      { ticketId: entry.ticketId, status: entry.status, action },
    )
  }
}
