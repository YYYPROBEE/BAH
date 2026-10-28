/**
 * 人工接管（handoff）平面（C5 / 人机接管 01）。
 *
 * ## 它是什么 / 不是什么
 *
 * **是**：把当前会话**标记为待人工接管**、给人工侧一份可读摘要、让坐席能通过
 * `handoff/operator-message` 对客户说话，并在交回时用一条冻结键 `user/message`
 * 把"刚才发生了什么"交给模型。状态落 `<root>/<sid>/handoff.json`，同 `--session`
 * 重启仍在。
 *
 * **不是**：坐席工作台、排队、技能路由、回交工单、SLA 自动升级。这些是完整的
 * handoff 产品，需要契约、权限与 UI（第 2 份）。
 *
 * ## 状态放在哪（诚实边界）
 *
 * 状态在 `HandoffPersistence`（生产 = 会话级文件 `handoff.json`）。会话日志里有
 * `handoff/*` 领域事件留痕。所以：
 *
 * - 审计能回答"这个会话曾经被要求接管过、谁在什么时候认领/交回/说了什么"；
 * - **进程重启后接管状态还在**（`handoff.json` 恢复），但 boot 不重放历史会话，
 *   所以"人工说过的话"只在 `session.jsonl` 里可审计查得，界面不显示；
 * - 同一 `--session` 重启后第一次落账会撞 `session-exists`（`core:persistence` 的
 *   `create()` 对已存在会话排他失败）。会话续写属 D4，**文档必须这么写**。
 *
 * ## 事件为什么走 `appendDomain`
 *
 * `handoff/*` 不在事件表 v1.0.1 的冻结键里（R-1 红线：不改 `core/api.ts` 契约面）。
 * 领域插件的新事件走 `session.appendDomain(type, data, { ignorable: true })`，
 * 旧 reader 跳过它，不会把一次接管读成日志空洞。
 *
 * ## 两条道（本方案最核心的设计）
 *
 * - 坐席的嘴：`handoff/operator-message`（领域事件、`ignorable`）→ **不进模型历史**，
 *   否则模型下一轮会以为自己答应过客户；
 * - 模型的记忆：交回时 `user/message(source='handoff-handover')`（冻结键）→ 进模型历史。
 */

import { BahError, reasonOf } from '@bah/util'

import type { SessionApi } from '@bah/runtime'

import type { SessionFiles } from '../persistence.ts'
import {
  createHandoffStore,
  type HandoffPersistence,
  type HandoffSnapshot,
} from './handoff-store.ts'

/** 摘要里最多带几条原话（再多人工侧也读不完，且会把会话内容摊得过开）。 */
const MAX_MESSAGES = 6

/** 单条原话截断长度（摘要不是导出，是"够人工接手"的最低限度）。 */
const MAX_TEXT = 200

/** 人工单条发言上限（字符，不是字节）。 */
export const MAX_OPERATOR_TEXT = 2000

/** 坐席显示名上限（字符）。 */
export const MAX_OPERATOR_NAME = 64

export interface HandoffMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** 人工侧看到的摘要（`GET /api/handoff` 的载荷）。 */
export interface HandoffSummary {
  readonly active: boolean
  readonly sessionId: string
  readonly lastSeq: number
  readonly turns: number
  readonly pendingTickets: number
  readonly messages: readonly HandoffMessage[]
  readonly reason?: string
  readonly at?: number
  /** 交回的操作者标识（只在 `resumed` 后有值，供审计对账）。 */
  readonly operator?: string
  /** 已等待毫秒（未接管为 0）。 */
  readonly waitedMs: number
  /** 超过 SLA（未设 slaMs 恒 false）。 */
  readonly overdue: boolean
  /** 是否已有坐席认领。 */
  readonly claimed: boolean
  /** 进入接管后的 turn 数。 */
  readonly turnsSinceHandoff: number
  /** 人工发言条数（只出数字，不出正文）。 */
  readonly operatorMessages: number
}

/** 进入 / 交回的结果。 */
export type HandoffEnterResult =
  | { readonly ok: true; readonly summary: HandoffSummary }
  | { readonly ok: false; readonly code: 'handoff-already-active' }

export type HandoffResumeResult =
  | { readonly ok: true; readonly summary: HandoffSummary }
  | { readonly ok: false; readonly code: 'handoff-not-active' | 'handoff-text-too-long' }

export type HandoffClaimResult =
  | { readonly ok: true; readonly summary: HandoffSummary }
  | { readonly ok: false; readonly code: 'handoff-not-active' | 'handoff-claimed-by-other' }

export type HandoffSayResult =
  | { readonly ok: true; readonly seq: number }
  | {
      readonly ok: false
      readonly code: 'handoff-not-active' | 'handoff-text-empty' | 'handoff-text-too-long'
    }

/** 心跳 / 超时判定的返回值（只读之外最多落一次告警事件）。 */
export interface HandoffHeartbeat {
  readonly waitedMs: number
  readonly overdue: boolean
}

/** 进入时落的事件（与 `session.appendDomain` 的载荷逐字对应）。 */
export type HandoffEventType =
  | 'handoff/requested'
  | 'handoff/claimed'
  | 'handoff/operator-message'
  | 'handoff/timeout-warned'
  | 'handoff/resumed'

export interface HandoffEventAppender {
  (type: HandoffEventType, data: Record<string, unknown>): void
}

/** 接管平面在 `WebDeps` 上的形状（处理器只依赖这些方法，测试可以给桩）。 */
export interface HandoffHandle {
  readonly active: boolean
  /** 当前 SLA（0 = 不告警）。metrics 直接读它，不要在别处再判一次。 */
  readonly slaMs: number
  enter(reason?: string): HandoffEnterResult
  resume(operator: string | undefined, handover?: string): HandoffResumeResult
  claim(operator: string): HandoffClaimResult
  say(operator: string, text: string): HandoffSayResult
  heartbeat(): HandoffHeartbeat
  summary(): HandoffSummary
}

/**
 * 接管状态机。
 *
 * 单写者：同一会话同时只可能有一个接管请求（重复请求返回 `handoff-already-active`，
 * 不刷新 `at`——刷新会让"已等了多久"这个运维数字失真）。
 *
 * 每次状态转移都**先写盘再改内存**：写盘失败时状态保持原样，调用方拿到 500；
 * 反过来会出现"系统说接管了、重启后没了"或"说交回了、其实还在接管"。
 */
export class HandoffRegistry implements HandoffHandle {
  private state: HandoffSnapshot | undefined
  private readonly store: HandoffPersistence
  readonly slaMs: number

  constructor(
    private readonly options: {
      readonly session: SessionApi
      readonly now: () => number
      readonly append: HandoffEventAppender
      readonly pendingTickets: () => number
      /** 落盘端口（HO-1）。缺省时用内存实现（**只给单测**；生产装配必须传）。 */
      readonly store?: HandoffPersistence
      /** SLA 毫秒（0 或未设 = 不告警）。 */
      readonly slaMs?: number
    },
  ) {
    this.store = options.store ?? createMemoryStore()
    this.slaMs = options.slaMs ?? 0
    // 构造即恢复：读到快照就 active；损坏文件抛错 ⇒ boot 失败（不静默当作未接管）
    this.state = this.loadSnapshot()
  }

  get active(): boolean {
    return this.state !== undefined
  }

  enter(reason?: string): HandoffEnterResult {
    if (this.state !== undefined) return { ok: false, code: 'handoff-already-active' }
    const at = this.options.now()
    const snapshot: HandoffSnapshot = {
      at,
      lastSeq: this.options.session.lastSeq(),
      ...(reason === undefined ? {} : { reason }),
    }
    // 先落盘再改内存：写盘失败 → 抛错 → 状态仍是未接管
    this.saveSnapshot(snapshot)
    this.state = snapshot
    // 事件失败最多丢一条证据，不会让"日志说接管了、系统还在自动回话"
    this.options.append('handoff/requested', {
      ...(reason === undefined ? {} : { reason }),
      at,
    })
    return { ok: true, summary: this.summary() }
  }

  resume(operator: string | undefined, handover?: string): HandoffResumeResult {
    const current = this.state
    if (current === undefined) return { ok: false, code: 'handoff-not-active' }
    // 先校验交接语再清状态：否则"交回失败但已经交回"会成为一个说不清的状态
    const text = typeof handover === 'string' ? handover.trim() : ''
    if ([...text].length > MAX_OPERATOR_TEXT) return { ok: false, code: 'handoff-text-too-long' }

    // 先清盘再改内存：清盘失败 → 抛错 → 仍是接管中
    this.clearStore()
    this.state = undefined
    const at = this.options.now()
    this.options.append('handoff/resumed', {
      ...(operator === undefined ? {} : { operator }),
      at,
    })
    // 交接语走冻结键：模型下一轮真的看得到（D4）；缺省/空串不落（T-17）
    if (text !== '') {
      this.options.session.append('user/message', { content: text, source: 'handoff-handover' })
    }
    return {
      ok: true,
      summary: {
        ...this.summary(),
        active: false,
        at: current.at,
        ...(current.reason === undefined ? {} : { reason: current.reason }),
        ...(operator === undefined ? {} : { operator }),
      },
    }
  }

  claim(operator: string): HandoffClaimResult {
    const current = this.state
    if (current === undefined) return { ok: false, code: 'handoff-not-active' }
    if (current.operator !== undefined && current.operator !== operator) {
      return { ok: false, code: 'handoff-claimed-by-other' }
    }
    // 幂等：同一人重复认领不落第二条事件，也不刷新 `at`
    if (current.operator === operator) return { ok: true, summary: this.summary() }

    const next: HandoffSnapshot = { ...current, operator }
    this.saveSnapshot(next)
    this.state = next
    this.options.append('handoff/claimed', {
      operator,
      at: this.options.now(),
      // 认领时刻不是"开始等待"的时刻：用户页计时必须继续用进入时间
      enteredAt: current.at,
    })
    return { ok: true, summary: this.summary() }
  }

  say(operator: string, text: string): HandoffSayResult {
    if (this.state === undefined) return { ok: false, code: 'handoff-not-active' }
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed === '') return { ok: false, code: 'handoff-text-empty' }
    if ([...trimmed].length > MAX_OPERATOR_TEXT) return { ok: false, code: 'handoff-text-too-long' }

    // 领域事件 + ignorable：不进模型历史（D3），但进审计链
    const event = this.options.session.appendDomain(
      'handoff/operator-message',
      { text: trimmed, operator, at: this.options.now() },
      { ignorable: true },
    )
    return { ok: true, seq: event.seq }
  }

  heartbeat(): HandoffHeartbeat {
    const current = this.state
    if (current === undefined) return { waitedMs: 0, overdue: false }
    const waitedMs = Math.max(0, this.options.now() - current.at)
    const overdue = this.slaMs > 0 && waitedMs > this.slaMs
    // 一次性告警：落盘成功后再改内存；同一接管只落一条（D6：只告警，不自动交回）
    if (overdue && current.warnedAt === undefined) {
      const at = this.options.now()
      const next: HandoffSnapshot = { ...current, warnedAt: at }
      this.saveSnapshot(next)
      this.state = next
      this.options.append('handoff/timeout-warned', { waitedMs, slaMs: this.slaMs, at })
    }
    return { waitedMs, overdue }
  }

  /** 当前状态的摘要（未接管时也返回，`active: false` + 会话现状）。 */
  summary(): HandoffSummary {
    const events = this.options.session.events()
    const state = this.state
    // 重启后 boot 不重放历史：内存日志的 lastSeq 可能小于快照里的 lastSeq。
    // 此时用 0（从本次进程的第一条算起）而不是旧 seq，否则"接管后的 turn 数"永远不增长。
    const fromSeq =
      state === undefined ? undefined : Math.min(state.lastSeq, this.options.session.lastSeq())
    const messages: HandoffMessage[] = []
    let turns = 0
    let turnsSinceHandoff = 0
    let operatorMessages = 0
    for (const event of events) {
      if (event.type === 'turn/end') {
        turns += 1
        if (fromSeq !== undefined && event.seq > fromSeq) turnsSinceHandoff += 1
      }
      if (fromSeq !== undefined && event.seq > fromSeq && String(event.type) === 'handoff/operator-message') {
        operatorMessages += 1
      }
      if (event.type === 'user/message') {
        const data = event.data as { content?: unknown; source?: string }
        // 运行时上下文是系统注入的，不是人说的话；交接语也是系统写的——两者都不能
        // 混进"最近 6 条原话"，否则坐席会以为客户说过这些。
        // `handoff-waiting` 要保留：那正是客户在等的时候说的话。
        if (data.source === 'runtime-context' || data.source === 'handoff-handover') continue
        messages.push({ role: 'user', text: textOf(data.content) })
      }
      if (event.type === 'assistant/message') {
        messages.push({ role: 'assistant', text: textOf((event.data as { content?: unknown }).content) })
      }
    }

    const waitedMs = state === undefined ? 0 : Math.max(0, this.options.now() - state.at)
    const overdue = this.slaMs > 0 && waitedMs > this.slaMs
    return {
      active: state !== undefined,
      sessionId: String(this.options.session.sessionId),
      lastSeq: this.options.session.lastSeq(),
      turns,
      pendingTickets: this.options.pendingTickets(),
      // 只带最近的若干条，且逐条截断：摘要的用途是"接手"，不是"导出会话"
      messages: messages
        .slice(-MAX_MESSAGES)
        .map((item) => ({ role: item.role, text: truncate(item.text) })),
      ...(state?.reason === undefined ? {} : { reason: state.reason }),
      ...(state === undefined ? {} : { at: state.at }),
      ...(state?.operator === undefined ? {} : { operator: state.operator }),
      waitedMs,
      overdue,
      claimed: state?.operator !== undefined,
      turnsSinceHandoff,
      operatorMessages,
    }
  }

  /** 读快照（损坏即拒启；非 `BahError` 的 IO 异常也归一成可判别的码）。 */
  private loadSnapshot(): HandoffSnapshot | undefined {
    try {
      return this.store.load()
    } catch (error) {
      if (error instanceof BahError) throw error
      throw new BahError('handoff-state-unreadable', '接管状态文件读取失败', {
        reason: reasonOf(error),
      })
    }
  }

  /** 写快照（失败一律 `handoff-state-unwritable`，I6）。 */
  private saveSnapshot(snapshot: HandoffSnapshot): void {
    try {
      this.store.save(snapshot)
    } catch (error) {
      throw new BahError('handoff-state-unwritable', '接管状态落盘失败，状态未改变', {
        reason: reasonOf(error),
      })
    }
  }

  /** 清快照（失败保持接管中，不假装交回成功）。 */
  private clearStore(): void {
    try {
      this.store.clear()
    } catch (error) {
      throw new BahError('handoff-state-unwritable', '接管状态清除失败，仍在接管中', {
        reason: reasonOf(error),
      })
    }
  }
}

/**
 * 按装配需要造一个接管平面。
 *
 * 放在本文件而不是 `web.ts` 里：`web.ts` 有 200 行的结构预算（W16），
 * 而"怎么把 session/adapter/会话根接到状态机上"属于接管平面自己的知识，不是渠道装配的知识。
 */
export function createHandoff(options: {
  readonly session: SessionApi
  readonly now: () => number
  readonly pendingTickets: () => number
  /** 会话文件服务（HO-1 的 root）。缺省/缺服务 ⇒ 抛 `handoff-store-unavailable`。 */
  readonly files: SessionFiles | undefined
  readonly slaMs?: number
}): HandoffHandle {
  const files = options.files
  if (files === undefined) {
    // 不静默退化成内存态（I6）：没有会话根就没有地方落接管状态，
    // 而"接管状态不落盘"正是本方案要修的那个缺陷。
    throw new BahError('handoff-store-unavailable', 'channel:web 需要 core:persistence 提供会话根')
  }
  return new HandoffRegistry({
    session: options.session,
    now: options.now,
    // 领域事件走 `appendDomain` + ignorable：不新增事件表冻结键（R-1），旧 reader 跳过
    append: (type, data) => {
      options.session.appendDomain(type, data, { ignorable: true })
    },
    pendingTickets: options.pendingTickets,
    store: createHandoffStore({
      root: files.root,
      sessionId: String(options.session.sessionId),
    }),
    ...(options.slaMs === undefined ? {} : { slaMs: options.slaMs }),
  })
}

/** 内存落盘（**只给单测**；生产装配必须传 `createHandoffStore`）。 */
function createMemoryStore(): HandoffPersistence {
  let snapshot: HandoffSnapshot | undefined
  return {
    load: () => snapshot,
    save: (next) => {
      snapshot = next
    },
    clear: () => {
      snapshot = undefined
    },
  }
}

/** 内容块数组 → 纯文本（与 `memory.ts` 同口径：只取 text 块）。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block !== 'object' || block === null) return ''
      if (!('type' in block) || block.type !== 'text') return ''
      return 'text' in block && typeof block.text === 'string' ? block.text : ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

function truncate(text: string): string {
  const chars = [...text]
  return chars.length <= MAX_TEXT ? text : `${chars.slice(0, MAX_TEXT).join('')}…`
}
