/**
 * 票据 lease（W12）：审批通过后的**短窗口**执行许可。
 *
 * 为什么不复用既有类型（宪法 §7.7）：
 * 本仓已存在两份结构不同的 `TicketRef`——`@bah/core` 的
 * `{ ticketId, fingerprint, amount?, expiresAt }` 与 `@bah/bank` 的 `{ ticketId, binding }`。
 * lease 是第三个概念（窗口 + 续租），不是第三份 `TicketRef`：它通过 `ticketId` 关联，
 * 不合并字段、不继承、不隐式转换。改任何一份既有 `TicketRef` 都违 R-1。
 *
 * 关系钉死：`lease.expiresAt <= ticket.expiresAt`（装配期 fail-loud）；
 * lease 过期 = 票据作废，`renew` 只能前移、不能重签一张已过期的票。
 */

import { BahError } from '@bah/util'

import type { TicketId } from '@bah/core'

/** 一张票据的执行 lease（独立类型，不与任何 `TicketRef` 同源）。 */
export interface TicketLease {
  readonly leaseId: string
  readonly ticketId: TicketId
  /** lease 到期时刻（epoch ms）；必须 ≤ 票据的 `expiresAt`。 */
  readonly expiresAt: number
}

/** 签发 lease 的输入。 */
export interface TicketLeaseIssueInput {
  readonly leaseId: string
  readonly ticketId: TicketId
  /** 签发时刻（注入钟）。 */
  readonly issuedAt: number
  /** lease 窗口（毫秒），必须 > 0。 */
  readonly ttlMs: number
  /** 票据自身的到期时刻（TTL 上限）。 */
  readonly ticketExpiresAt: number
}

/** 续租输入。 */
export interface TicketLeaseRenewInput {
  /** 当前时刻（注入钟）。 */
  readonly now: number
  /** 新的到期时刻；必须**前移**且 ≤ 票据 TTL。 */
  readonly expiresAt: number
  readonly ticketExpiresAt: number
}

function invalid(message: string, detail: Readonly<Record<string, unknown>>): BahError {
  return new BahError('lease-invalid', `policy: lease-invalid: ${message}`, detail)
}

function requireFinite(value: number, field: string, detail: Readonly<Record<string, unknown>>): void {
  if (!Number.isFinite(value)) {
    throw invalid(`${field} 必须是有限数`, { ...detail, field, value })
  }
}

/**
 * 签发 lease。
 *
 * @throws `BahError('lease-invalid')` 字段非法 / TTL 非正
 * @throws `BahError('lease-outlives-ticket')` lease 越过票据 TTL
 */
export function issueTicketLease(input: TicketLeaseIssueInput): TicketLease {
  if (typeof input.leaseId !== 'string' || input.leaseId.trim().length === 0) {
    throw invalid('leaseId 必须是非空字符串', { leaseId: input.leaseId })
  }
  if (typeof input.ticketId !== 'string' || input.ticketId.trim().length === 0) {
    throw invalid('ticketId 必须是非空字符串', { ticketId: input.ticketId })
  }
  requireFinite(input.issuedAt, 'issuedAt', { ticketId: input.ticketId })
  requireFinite(input.ttlMs, 'ttlMs', { ticketId: input.ticketId })
  requireFinite(input.ticketExpiresAt, 'ticketExpiresAt', { ticketId: input.ticketId })
  if (input.ttlMs <= 0) {
    throw invalid('ttlMs 必须 > 0（lease 不能签发即过期）', {
      ticketId: input.ticketId,
      ttlMs: input.ttlMs,
    })
  }

  const lease: TicketLease = {
    leaseId: input.leaseId,
    ticketId: input.ticketId,
    expiresAt: input.issuedAt + input.ttlMs,
  }
  assertLeaseWithinTicket(lease, input.ticketExpiresAt)
  return lease
}

/**
 * 装配期硬校验：lease 不得越过票据 TTL。
 *
 * 调用方（宿主 / 账本）必须 fail-loud——静默接受会让"lease 是短窗口"这句话变成谎言，
 * 过期票据仍能穿过 lease 闸门。
 *
 * @throws `BahError('lease-outlives-ticket')`
 */
export function assertLeaseWithinTicket(lease: TicketLease, ticketExpiresAt: number): void {
  if (lease.expiresAt > ticketExpiresAt) {
    throw new BahError(
      'lease-outlives-ticket',
      `policy: lease-outlives-ticket: lease(${String(lease.expiresAt)}) 晚于票据 TTL(${String(ticketExpiresAt)})`,
      { leaseId: lease.leaseId, ticketId: lease.ticketId, expiresAt: lease.expiresAt, ticketExpiresAt },
    )
  }
}

/** lease 是否已过期（`now >= expiresAt` 即过期，边界归过期侧）。 */
export function isLeaseExpired(lease: TicketLease, now: number): boolean {
  return now >= lease.expiresAt
}

/**
 * 核销前的 lease 校验。
 *
 * @throws `BahError('ticket-expired')` lease 已过期（不重签、不放行）
 */
export function assertLeaseUsable(lease: TicketLease, now: number): void {
  if (isLeaseExpired(lease, now)) {
    throw new BahError(
      'ticket-expired',
      `policy: ticket-expired: lease 已过期（${String(lease.expiresAt)} <= ${String(now)}）`,
      { leaseId: lease.leaseId, ticketId: lease.ticketId, expiresAt: lease.expiresAt, now },
    )
  }
}

/**
 * 续租：`leaseId` 不变，只把到期时刻**前移**。
 *
 * 三条规则：
 * 1. 已过期的 lease 不能续（`ticket-expired`）——重签等于把作废票据复活；
 * 2. 新到期时刻必须严格晚于当前（`lease-renew-invalid`）——"续租缩短窗口"是调用方把参数传错了；
 * 3. 新到期时刻仍受票据 TTL 约束（`lease-outlives-ticket`）。
 *
 * @throws `BahError('ticket-expired')` / `BahError('lease-renew-invalid')` /
 *   `BahError('lease-outlives-ticket')`
 */
export function renewTicketLease(lease: TicketLease, input: TicketLeaseRenewInput): TicketLease {
  requireFinite(input.now, 'now', { leaseId: lease.leaseId })
  requireFinite(input.expiresAt, 'expiresAt', { leaseId: lease.leaseId })
  requireFinite(input.ticketExpiresAt, 'ticketExpiresAt', { leaseId: lease.leaseId })
  assertLeaseUsable(lease, input.now)
  if (input.expiresAt <= lease.expiresAt) {
    throw new BahError(
      'lease-renew-invalid',
      `policy: lease-renew-invalid: 续租只能前移（${String(input.expiresAt)} <= ${String(lease.expiresAt)}）`,
      { leaseId: lease.leaseId, ticketId: lease.ticketId, expiresAt: input.expiresAt, current: lease.expiresAt },
    )
  }
  const renewed: TicketLease = { ...lease, expiresAt: input.expiresAt }
  assertLeaseWithinTicket(renewed, input.ticketExpiresAt)
  return renewed
}
