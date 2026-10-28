/**
 * HALT 状态机（W07 / HP-3）：进程级 `RUNNING | HALTED` 单例。
 *
 * ## 它是什么 / 不是什么
 *
 * - 是**纯状态机**：不读时钟、不写会话、不认识任何领域包；时钟 / 落账 / 解除票据
 *   全部由宿主注入（与 sentry 其余模块同一纪律）。
 * - 不是断路器（那是 `SentryBreaker`）：断路器只冻结**非绿工具**，可被 `safety:sentry`
 *   人工解冻；HALT 是**全系统停机**，新 turn / 任意工具 / plan 节点三处全拒，
 *   解除只能凭会话内 U 盾 MFA 审批票据。
 *
 * ## 触发条件写死三条（不得动态学习、不得新增第四条）
 *
 * | 原因 | 谁触发 |
 * |---|---|
 * | `chain-broken` | 审计链断裂（W08 接线，本单只提供入口） |
 * | `p0-threshold` | P0 规则（`destructive` / `exfil` 两族）累计命中 3 次 |
 * | `manual` | 人工 `bah halt`（管理路由） |
 *
 * P0 计数在**一次连续 HALT 周期内**累计：解除后清零，重新从 0 开始数。
 * 这样"解除后第一次误命中"不会立刻把系统再停一次（解除本身是人工动作，
 * 需要给运维留出观察窗口）；同时 3 次阈值仍然写死。
 *
 * ## 为什么 `safety/*` 走 `session.append` 而不是 `appendDomain`
 *
 * `scripts/verify-session-events.ts` 的接收者识别只认 `append(`；用 `appendDomain`
 * 会让事件**静默逃过**"声明 + 反向覆盖"门禁（event-table v1.0.1 §3.1）。载荷字段
 * 与事件表冻结版本逐字一致：`{ reason, detail?, at }` / `{ ticketId, mfa: true, at }`。
 */

import { defineService } from '@bah/core'

import type { ServiceKey } from '@bah/core'

/** 触发原因（写死三条）。 */
export type HaltReason = 'chain-broken' | 'p0-threshold' | 'manual'

/** 进程级状态（只有两态；没有"半停"）。 */
export type HaltStatus = 'RUNNING' | 'HALTED'

/** P0 命中触发 HALT 的次数（**安全下限，故意不接 Config**：W07 §1 写死三条触发条件，
 *  接成可调就意味着运维能把 HALT 调成"永不触发"）。 */
export const P0_HALT_AFTER_HITS = 3

/** `safety/*` 的载荷表（事件表 v1.0.1 冻结；一个字段都不许加减）。 */
export interface SafetySessionEventMap {
  /** 系统进入 HALT。 */
  'safety/halt': {
    readonly reason: HaltReason
    readonly detail?: string
    readonly at: number
  }
  /** 人工解除 HALT（只有校验通过的票据才会落这条）。 */
  'safety/unfreeze': {
    readonly ticketId: string
    readonly mfa: true
    readonly at: number
  }
}

declare module '@bah/core' {
  interface SessionEventMap extends SafetySessionEventMap {}
}

/** 本文件声明的事件类型。 */
export type HaltEventType = keyof SafetySessionEventMap

/** 事件载荷（按类型收窄）。 */
export type HaltEventData<T extends HaltEventType> = SafetySessionEventMap[T]

/** 一条待落账的 HALT 事件（宿主按 `type` 选 `session.append` 的重载）。 */
export type HaltEvent = {
  [K in HaltEventType]: {
    readonly type: K
    readonly data: SafetySessionEventMap[K]
  }
}[HaltEventType]

/** 事件全量键（门禁与文档用；顺序 = 声明顺序）。 */
export const SAFETY_SESSION_EVENT_TYPES = [
  'safety/halt',
  'safety/unfreeze',
] as const satisfies readonly HaltEventType[]

/** 票据生命周期状态（与 interaction 的账本同值集；这里只读）。 */
export type HaltTicketStatus = 'issued' | 'approved' | 'redeemed' | 'consumed' | 'blocked'

/**
 * 解除 HALT 的票据视图。
 *
 * `mfa` 只能由**已经验过 U 盾**的审批链给出；状态机在解除时仍逐项校验
 * `approved` / `mfa` / 未过期（类型不负责安全，运行期判定才负责）。
 */
export interface HaltTicket {
  readonly ticketId: string
  readonly status: HaltTicketStatus
  /** 票据过期时刻（epoch ms）。 */
  readonly expiresAt: number
  /** 是否完成过 MFA（U 盾）验证。 */
  readonly mfa: boolean
}

/** 解除失败的结构化理由码。 */
export type HaltUnfreezeCode =
  | 'halt-disabled'
  | 'halt-not-halted'
  | 'halt-ticket-unknown'
  | 'halt-ticket-not-approved'
  | 'halt-ticket-mfa-required'
  | 'halt-ticket-expired'

/** 解除结果（成功没有附加字段：状态已经变了）。 */
export type HaltUnfreezeResult = { readonly ok: true } | {
  readonly ok: false
  readonly code: HaltUnfreezeCode
}

/** 申请解除票据的结果（票据由会话内审批签发，不是 CLI 自己造的）。 */
export type HaltTicketRequestResult =
  | { readonly ok: true; readonly ticketId: string; readonly expiresAt: number }
  | { readonly ok: false; readonly code: HaltUnfreezeCode | 'halt-approval-absent' | 'halt-approval-rejected' }

/** 对外观察视图（审计面板 / 用例 / 就绪检查）。 */
export interface HaltView {
  readonly enabled: boolean
  readonly status: HaltStatus
  readonly halted: boolean
  readonly reason?: HaltReason
  readonly detail?: string
  /** 本 HALT 周期内累计的 P0 命中数（解除后清零）。 */
  readonly p0Hits: number
  /**
   * 本次 HALT 是否来自**重启恢复**（磁盘上的停机快照），而不是本进程内触发。
   *
   * 运维看板上这两个要分开：`restored=true` 意味着"上一轮停机没人解除"，
   * 与"刚刚又触发了一次" 是完全不同的处置。
   */
  readonly restored: boolean
}

/**
 * 跨重启的 HALT 快照。
 *
 * **刻意不含票据**：解除 HALT 必须重新走一次 U 盾 MFA 审批（`requestUnfreeze()`）。
 * 把票据写进磁盘等于把"解除凭据"变成可离线复制的文件，一次性票据也就失去意义。
 */
export interface HaltSnapshot {
  readonly reason: HaltReason
  readonly detail?: string
  /** 进入 HALT 的时刻（epoch ms，由注入钟给出）。 */
  readonly at: number
}

/**
 * HALT 状态的持久化端口（宿主实现；safety 包不碰 `node:fs`）。
 *
 * 三条纪律：
 *
 * 1. `load()` 抛错 = **停机证据不可读**，必须让宿主拒启。静默当作 `RUNNING`
 *    等于"文件坏了就自动解除停机"，这是最坏的一种降级。
 * 2. `save()` 在 `safety/halt` 落账**之后**调用。宁可少一份磁盘副本（进程恰好在此崩溃），
 *    也不要出现"磁盘说停了、会话日志说没停"的两份互相矛盾的证据。
 * 3. 只有 `HALTED → RUNNING` 的**票据解除**才 `clear()`。重启本身不清。
 */
export interface HaltPersistence {
  load(): HaltSnapshot | undefined
  save(snapshot: HaltSnapshot): void
  clear(): void
}

/** `safety:halt` 服务面。 */
export interface HaltHandle {
  readonly enabled: boolean
  readonly status: HaltStatus
  readonly halted: boolean
  readonly reason?: HaltReason
  /** 进入 HALT（幂等：已 HALT 时返回 `false` 且不落第二条事件）。 */
  halt(reason: HaltReason, detail?: string): boolean
  /** 记一次 P0 命中；第 3 次返回 `true` 并进入 HALT。 */
  noteP0Hit(): boolean
  /** 登记一张**已由会话内 MFA 审批签发**的解除票据。 */
  registerTicket(ticket: HaltTicket): void
  /** 凭票据解除（唯一解除路径）。 */
  unfreeze(ticketId: string): HaltUnfreezeResult
  /** 申请一张解除票据（走宿主注入的审批端口；没有端口 = 不可申请）。 */
  requestUnfreeze(): Promise<HaltTicketRequestResult>
  /** 当前观察视图。 */
  view(): HaltView
}

/** 装配参数（全部注入，便于单测替换时钟 / 落账 / 票据）。 */
export interface HaltOptions {
  readonly now: () => number
  /** 事件出口（宿主接 `session.append`；单测接收集器）。 */
  readonly recordHalt: (event: HaltEvent) => void
  /** 总开关（`safety.halt.enabled`，默认 true）。 */
  readonly enabled?: boolean
  /**
   * 解除票据的申请端口（宿主实现：一次 `interaction:approval` 的 U 盾审批）。
   *
   * 缺省 = 本进程没有审批面（headless 单测 / 最小装配）：`requestUnfreeze()` 返回
   * `halt-approval-absent`，**绝不**自己造一张票。
   */
  readonly requestTicket?: () => Promise<HaltTicket | undefined>
  /**
   * 跨重启持久化（宿主实现：会话根下的 `halt.json`）。
   *
   * 缺省 = 进程级停机（重启即解除）——这是**降级**，不是默认：生产装配必须注入。
   * 单测与最小装配不注入，语义与 W07 原状逐字一致。
   */
  readonly persistence?: HaltPersistence
}

/** 服务键：`safety:halt`（宿主 / 审计面板 / 管理路由按它取用）。 */
export const HALT_SERVICE: ServiceKey<HaltHandle> = defineService<HaltHandle>('safety:halt')

/**
 * HALT 状态机。
 *
 * 所有转移都是同步的（单线程事件循环内没有竞态）：`halt()` / `unfreeze()` 在同一 tick
 * 内完成判定与落账，不存在"判定完了但事件还没落"的中间态。
 */
export class HaltState implements HaltHandle {
  private readonly now: () => number
  private readonly recordHalt: (event: HaltEvent) => void
  private readonly requestTicket: (() => Promise<HaltTicket | undefined>) | undefined
  private readonly persistence: HaltPersistence | undefined
  private readonly enabledFlag: boolean

  private current: HaltStatus = 'RUNNING'
  private currentReason: HaltReason | undefined
  private currentDetail: string | undefined
  private p0Hits = 0
  private restored = false
  private readonly tickets = new Map<string, HaltTicket>()

  constructor(options: HaltOptions) {
    this.now = options.now
    this.recordHalt = options.recordHalt
    this.requestTicket = options.requestTicket
    this.persistence = options.persistence
    this.enabledFlag = options.enabled ?? true

    // 重启恢复：`load()` 抛错（文件损坏 / 不可读）直接冒泡——停机证据读不出来时
    // 拒绝启动是唯一安全答案，静默当 RUNNING 等于"文件坏了就自动解除停机"。
    if (this.persistence !== undefined && this.enabledFlag) {
      const snapshot = this.persistence.load()
      if (snapshot !== undefined) {
        this.current = 'HALTED'
        this.currentReason = snapshot.reason
        this.currentDetail = snapshot.detail
        this.restored = true
      }
    }
  }

  get enabled(): boolean {
    return this.enabledFlag
  }

  get status(): HaltStatus {
    return this.current
  }

  get halted(): boolean {
    return this.current === 'HALTED'
  }

  get reason(): HaltReason | undefined {
    return this.currentReason
  }

  halt(reason: HaltReason, detail?: string): boolean {
    if (!this.enabledFlag) return false
    // 幂等：重复 HALT 不落第二条事件（TC-W07-07）
    if (this.halted) return false
    const at = this.now()
    this.current = 'HALTED'
    this.currentReason = reason
    this.currentDetail = detail
    this.restored = false
    this.recordHalt({
      type: 'safety/halt',
      data: { reason, ...(detail === undefined ? {} : { detail }), at },
    })
    // 落账**之后**才写盘：宁可少一份副本，也不要"磁盘说停了、日志说没停"
    this.persistence?.save({ reason, ...(detail === undefined ? {} : { detail }), at })
    return true
  }

  noteP0Hit(): boolean {
    if (!this.enabledFlag || this.halted) return false
    this.p0Hits += 1
    if (this.p0Hits < P0_HALT_AFTER_HITS) return false
    return this.halt(
      'p0-threshold',
      `P0 规则累计命中 ${String(this.p0Hits)} 次（阈值 ${String(P0_HALT_AFTER_HITS)}）`,
    )
  }

  registerTicket(ticket: HaltTicket): void {
    // 先清过期票：长跑宿主里 `requestUnfreeze` 可能被反复调用，过期/失败的票据
    // 不应该无限驻留（与交互包 TicketLedger 的软上限同一考虑）。
    const at = this.now()
    for (const [ticketId, existing] of this.tickets) {
      if (existing.expiresAt <= at) this.tickets.delete(ticketId)
    }
    this.tickets.set(ticket.ticketId, ticket)
  }

  unfreeze(ticketId: string): HaltUnfreezeResult {
    if (!this.enabledFlag) return { ok: false, code: 'halt-disabled' }
    if (!this.halted) return { ok: false, code: 'halt-not-halted' }

    const ticket = this.tickets.get(ticketId)
    if (ticket === undefined) return { ok: false, code: 'halt-ticket-unknown' }
    if (ticket.status !== 'approved') {
      // 终态不可能再变成 approved：删掉，别让失败的票在长跑进程里堆积
      this.tickets.delete(ticketId)
      return { ok: false, code: 'halt-ticket-not-approved' }
    }
    if (!ticket.mfa) {
      this.tickets.delete(ticketId)
      return { ok: false, code: 'halt-ticket-mfa-required' }
    }

    const at = this.now()
    if (ticket.expiresAt <= at) {
      this.tickets.delete(ticketId)
      return { ok: false, code: 'halt-ticket-expired' }
    }

    // 票据一次性：解除成功后立即作废，重放同一张票不可能再解一次
    this.tickets.delete(ticketId)
    this.current = 'RUNNING'
    this.currentReason = undefined
    this.currentDetail = undefined
    this.p0Hits = 0
    this.restored = false
    this.recordHalt({ type: 'safety/unfreeze', data: { ticketId, mfa: true, at } })
    // 只有凭票据解除才清盘；`halt()` 之外的任何路径都不得清除停机证据
    this.persistence?.clear()
    return { ok: true }
  }

  async requestUnfreeze(): Promise<HaltTicketRequestResult> {
    if (!this.enabledFlag) return { ok: false, code: 'halt-disabled' }
    if (!this.halted) return { ok: false, code: 'halt-not-halted' }
    if (this.requestTicket === undefined) return { ok: false, code: 'halt-approval-absent' }

    const ticket = await this.requestTicket()
    if (ticket === undefined) return { ok: false, code: 'halt-approval-rejected' }
    this.registerTicket(ticket)
    return { ok: true, ticketId: ticket.ticketId, expiresAt: ticket.expiresAt }
  }

  view(): HaltView {
    return {
      enabled: this.enabledFlag,
      status: this.current,
      halted: this.halted,
      p0Hits: this.p0Hits,
      restored: this.restored,
      ...(this.currentReason === undefined ? {} : { reason: this.currentReason }),
      ...(this.currentDetail === undefined ? {} : { detail: this.currentDetail }),
    }
  }
}
