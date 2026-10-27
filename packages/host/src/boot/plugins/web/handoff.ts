/**
 * 人工接管（handoff）的最小平面（C5）。
 *
 * ## 它是什么 / 不是什么
 *
 * **是**：把当前会话**标记为待人工接管**，并给人工侧一份可读摘要（最近几轮原话、
 * 待应答票据数、进入时间与原因）。进入后 Web 的 `/api/turn` 一律 409，
 * 模型不再被自动驱动——这正是"接管"与"审批弹窗"的区别：审批是**放行一次动作**，
 * 接管是**把会话的控制权交出去**。
 *
 * **不是**：坐席工作台、排队、技能路由、回交工单、SLA。这些是完整的 handoff 产品，
 * 需要契约、权限与 UI（见分类表 C5 的"不做"）。
 *
 * ## 状态放在哪（诚实边界）
 *
 * 状态在**进程内**（`HandoffRegistry`），会话日志里有 `handoff/requested` /
 * `handoff/resumed` 两条领域事件留痕。所以：
 *
 * - 审计能回答"这个会话曾经被要求接管过、谁在什么时候交回的"；
 * - 但**进程重启后状态回到 `active`**（当前 boot 不重放历史会话的事件面）。
 *   这与 HALT 不同：HALT 有部署级 `halt.json`，重启仍然停机；handoff 没有。
 *   要跨重启保留，得先让 boot 支持恢复会话，那是 D4 的活。**文档必须这么写。**
 *
 * ## 事件为什么走 `appendDomain`
 *
 * `handoff/*` 不在事件表 v1.0.1 的冻结键里（R-1 红线：不改 `core/api.ts` 契约面）。
 * 领域插件的新事件走 `session.appendDomain(type, data, { ignorable: true })`，
 * 旧 reader 跳过它，不会把一次接管读成日志空洞。
 */

import type { SessionApi } from '@bah/runtime'

/** 摘要里最多带几条原话（再多人工侧也读不完，且会把会话内容摊得过开）。 */
const MAX_MESSAGES = 6

/** 单条原话截断长度（摘要不是导出，是"够人工接手"的最低限度）。 */
const MAX_TEXT = 200

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
}

/** 进入 / 交回的结果。 */
export type HandoffEnterResult =
  | { readonly ok: true; readonly summary: HandoffSummary }
  | { readonly ok: false; readonly code: 'handoff-already-active' }

export type HandoffResumeResult =
  | { readonly ok: true; readonly summary: HandoffSummary }
  | { readonly ok: false; readonly code: 'handoff-not-active' }

/** 进入时落的事件（与 `session.appendDomain` 的载荷逐字对应）。 */
export interface HandoffEventAppender {
  (type: 'handoff/requested' | 'handoff/resumed', data: Record<string, unknown>): void
}

/** 接管平面在 `WebDeps` 上的形状（处理器只依赖这四项，测试可以给桩）。 */
export interface HandoffHandle {
  readonly active: boolean
  enter(reason?: string): HandoffEnterResult
  resume(operator: string | undefined): HandoffResumeResult
  summary(): HandoffSummary
}

/**
 * 接管状态机（进程内）。
 *
 * 单写者：同一会话同时只可能有一个接管请求（重复请求返回 `handoff-already-active`，
 * 不刷新 `at`——刷新会让"已等了多久"这个运维数字失真）。
 */
export class HandoffRegistry implements HandoffHandle {
  private state:
    | { readonly at: number; readonly reason?: string; operator?: string }
    | undefined

  constructor(
    private readonly options: {
      readonly session: SessionApi
      readonly now: () => number
      readonly append: HandoffEventAppender
      readonly pendingTickets: () => number
    },
  ) {}

  get active(): boolean {
    return this.state !== undefined
  }

  enter(reason?: string): HandoffEnterResult {
    if (this.state !== undefined) return { ok: false, code: 'handoff-already-active' }
    const at = this.options.now()
    this.state = { at, ...(reason === undefined ? {} : { reason }) }
    // 先改状态再落事件：事件失败时状态已经是"待接管"，宁可少一条证据也不要
    // "日志说接管了、系统还在自动回话"
    this.options.append('handoff/requested', {
      ...(reason === undefined ? {} : { reason }),
      at,
    })
    return { ok: true, summary: this.summary() }
  }

  resume(operator: string | undefined): HandoffResumeResult {
    const current = this.state
    if (current === undefined) return { ok: false, code: 'handoff-not-active' }
    const at = this.options.now()
    // 先清状态再落事件：交回之后 `/api/turn` 必须立刻恢复可用，
    // 落账失败最多丢一条证据，不会让会话卡在"已交回但仍拒消息"的中间态。
    this.state = undefined
    this.options.append('handoff/resumed', {
      ...(operator === undefined ? {} : { operator }),
      at,
    })
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

  /** 当前状态的摘要（未接管时也返回，`active: false` + 会话现状）。 */
  summary(): HandoffSummary {
    const events = this.options.session.events()
    const messages: HandoffMessage[] = []
    let turns = 0
    for (const event of events) {
      if (event.type === 'turn/end') turns += 1
      if (event.type === 'user/message') {
        const data = event.data as { content?: unknown; source?: string }
        // 运行时上下文是系统注入的，不是人说的话——摘要里不能冒充对话
        if (data.source === 'runtime-context') continue
        messages.push({ role: 'user', text: textOf(data.content) })
      }
      if (event.type === 'assistant/message') {
        messages.push({ role: 'assistant', text: textOf((event.data as { content?: unknown }).content) })
      }
    }

    return {
      active: this.state !== undefined,
      sessionId: String(this.options.session.sessionId),
      lastSeq: this.options.session.lastSeq(),
      turns,
      pendingTickets: this.options.pendingTickets(),
      // 只带最近的若干条，且逐条截断：摘要的用途是"接手"，不是"导出会话"
      messages: messages
        .slice(-MAX_MESSAGES)
        .map((item) => ({ role: item.role, text: truncate(item.text) })),
      ...(this.state?.reason === undefined ? {} : { reason: this.state.reason }),
      ...(this.state === undefined ? {} : { at: this.state.at }),
      ...(this.state?.operator === undefined ? {} : { operator: this.state.operator }),
    }
  }
}

/**
 * 按装配需要造一个接管平面。
 *
 * 放在本文件而不是 `web.ts` 里：`web.ts` 有 200 行的结构预算（W16），
 * 而"怎么把 session/adapter 接到状态机上"属于接管平面自己的知识，不是渠道装配的知识。
 */
export function createHandoff(options: {
  readonly session: SessionApi
  readonly now: () => number
  readonly pendingTickets: () => number
}): HandoffHandle {
  return new HandoffRegistry({
    session: options.session,
    now: options.now,
    // 领域事件走 `appendDomain` + ignorable：不新增事件表冻结键（R-1），旧 reader 跳过
    append: (type, data) => {
      options.session.appendDomain(type, data, { ignorable: true })
    },
    pendingTickets: options.pendingTickets,
  })
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
