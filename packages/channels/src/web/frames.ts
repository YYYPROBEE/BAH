/**
 * Web 渠道的**渲染原语**（帧）。
 *
 * 为什么要中间层而不是"事件直接进 DOM"：
 * 1. 帧是纯数据：同一串会话事件 → 同一串帧（无时钟、无随机、无 DOM），
 *    因此"两次渲染 diff = 0"是构造出来的性质，而不是碰巧相等（T-WEB-007）；
 * 2. 帧可快照：断线重同步时服务端重放同一归约器，客户端整体替换即可，
 *    不需要"倒推 DOM 该怎么回滚"（T-WEB-001）；
 * 3. 帧可测：node 面测归约器，jsdom 面只测"帧 → 节点"。
 *
 * 纪律：本文件只有**类型与判别工具**，不含任何推导逻辑（推导在 `project.ts`）。
 */

import { assertNever } from '@bah/util'

import type { ApprovalDecision } from '@bah/runtime'

/** 权限级别在渠道侧的投影（`unknown` 表示事件里没带，绝不猜）。 */
export type FrameTier = 'green' | 'yellow' | 'red' | 'unknown'

/** 文本色调（对应 BAH DS 的 `--text-*` / `--status-*`，不引入新色）。 */
export type FrameTone = 'default' | 'muted' | 'success' | 'warning' | 'danger'

/** 徽标色调（对应 `.ds-tag--*`）。 */
export type TagTone = 'default' | 'brand' | 'success' | 'warning' | 'danger'

/** 一个徽标。 */
export interface FrameTag {
  readonly text: string
  readonly tone: TagTone
}

/** 一个字段行。 */
export interface CardField {
  readonly label: string
  readonly value: string
  /** 是否是金额字段（金额要按"是否有工具结果"降级，见 `amount.ts`）。 */
  readonly amount?: boolean
  readonly tone?: FrameTone
  /** 等宽数字（ID / 理由码 / 计数）。 */
  readonly mono?: boolean
}

/** 表格（账户列表、交易流水）。 */
export interface CardTable {
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/** 卡片视图：领域 `UiCard` 或工具结果文本在渠道侧的**唯一**呈现形态。 */
export interface CardView {
  /** 原始卡片种类（`bank.transfer-created` 等；文本派生时为 `tool.content`）。 */
  readonly kind: string
  /** 模板名（视图按它选布局）。 */
  readonly template: 'transfer' | 'wealth' | 'ledger' | 'analysis' | 'verify' | 'knowledge' | 'generic'
  readonly title: string
  readonly subtitle?: string
  readonly fields: readonly CardField[]
  readonly table?: CardTable
  readonly tags: readonly FrameTag[]
  /** 风险提示（理财合规硬要求：**永不折叠**）。 */
  readonly disclaimer?: { readonly id: string; readonly text: string }
  /** 工具结果正文（已从 `tool/result.content` 取出，保留换行）。 */
  readonly body?: string
  /** 结构化理由码（拒绝 / 失败 / 知识拒答）。 */
  readonly code?: string
  readonly note?: string
}

/** 一轮的开始 / 结束。 */
export interface TurnFrame {
  readonly kind: 'turn'
  readonly seq: number
  readonly at: number
  readonly turn: number
  readonly phase: 'start' | 'end'
  /** 结束原因（`phase === 'end'` 时存在）。 */
  readonly endKind?: 'completed' | 'blocked' | 'aborted' | 'max-tokens' | 'guard-stopped' | 'failed'
  readonly reason?: string
}

/** 一条消息块。 */
export type MessageBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'other'; readonly summary: string }

/** 消息气泡。 */
export interface MessageFrame {
  readonly kind: 'message'
  readonly seq: number
  readonly at: number
  readonly role: 'user' | 'assistant'
  readonly blocks: readonly MessageBlock[]
  /** 本轮发起的工具调用（只给 ID / 名字，明细在 `tool` 帧）。 */
  readonly toolCalls?: readonly { readonly callId: string; readonly name: string }[]
  /** 消息来源（`context` = 工具后置纠正文本，不显示为用户发言）。 */
  readonly source?: string
}

/**
 * 流式增量（ephemeral）。
 *
 * 不是事实：不入会话日志、不占 `seq`、断线即丢。权威仍是随后的 `assistant/message`。
 * 为什么单独一帧：UI 需要"边生成边显示"，但不能让分片污染 append-only 日志
 * （否则 `deriveMessages` 会把半句话当成历史）。
 */
export interface DeltaFrame {
  readonly kind: 'delta'
  readonly at: number
  readonly text: string
}

/** 工具卡片三态：待执行 / 完成 / 被拒（含执行失败）。 */
export interface ToolFrame {
  readonly kind: 'tool'
  readonly seq: number
  readonly at: number
  readonly callId: string
  readonly name: string
  readonly title: string
  readonly state: 'pending' | 'done' | 'denied'
  /** 失败细分：`denied` = 判决拦截；`failed` = 执行期错误（文案必须不同）。 */
  readonly reasonKind?: 'denied' | 'failed'
  readonly tier: FrameTier
  /** 金额是否已被本 turn 的工具结果证实（false → 标灰 + "待确认"）。 */
  readonly amountConfirmed: boolean
  readonly card?: CardView
  readonly code?: string
  readonly reason?: string
  readonly durationMs?: number
}

/** 审批弹窗（六要素 + 挑战 + 截止时刻）。 */
export interface ApprovalFrame {
  readonly kind: 'approval'
  readonly seq: number
  readonly at: number
  readonly ticketId: string
  readonly callId: string
  readonly name: string
  /** 操作类型（渠道可读标题）。 */
  readonly operation: string
  readonly amountText?: string
  readonly amountConfirmed: boolean
  readonly payeeName?: string
  /** 收款人手机号（**已脱敏**：前 3 后 4；原值不进前端）。 */
  readonly payeePhone?: string
  /** 手续费展示文本（来自本 turn 的 `transfer_preview` 结果；没有就不编）。 */
  readonly feeText?: string
  readonly tier: FrameTier
  /** 票据 TTL 截止时刻（epoch ms）；客户端只做视觉倒计时。 */
  readonly expiresAt?: number
  readonly challenge?: 'face' | 'sms' | 'ushield'
  /** 拒绝理由是否必填（红级 / 资金类）。 */
  readonly rejectReasonRequired: boolean
}

/** 审批收尾。 */
export interface ApprovalClosedFrame {
  readonly kind: 'approval-closed'
  readonly seq: number
  readonly at: number
  readonly ticketId: string
  readonly decision: ApprovalDecision
  readonly label: string
  readonly reason?: string
  readonly code?: string
}

/** 行内提示（判停 / 失败 / 压缩 / 安全拦截）。 */
export interface NoticeFrame {
  readonly kind: 'notice'
  readonly seq: number
  readonly at: number
  readonly level: 'info' | 'success' | 'warning' | 'danger'
  readonly title: string
  readonly text?: string
  readonly code?: string
}

/** 审计时间线条目。 */
export interface AuditFrame {
  readonly kind: 'audit'
  readonly seq: number
  readonly at: number
  /** `HH:MM:SS`（服务端按 UTC 格式化，前端不再算时区）。 */
  readonly timeText: string
  /** 分类（审批 / 票据 / 工具 / 安全 / 知识 / 轮次）。 */
  readonly category: 'approval' | 'ticket' | 'tool' | 'safety' | 'knowledge' | 'turn'
  readonly label: string
  readonly summary: string
  readonly code?: string
  readonly ticketId?: string
  readonly toolName?: string
}

/**
 * DAG 节点。
 *
 * B2（2026-10-27）：新增 `plan` 节点与 plan 执行状态——`running` / `failed` /
 * `skipped` / `incident` / `cancelled` 与 `PLAN_NODE_STATES` 对齐；
 * `incident` 与 `failed` 在视图上**必须可区分**（security-design §4 第 6 条的自认缺口）。
 */
export interface DagNode {
  readonly id: string
  readonly label: string
  readonly kind: 'step' | 'call' | 'plan'
  readonly step: number
  readonly tier: FrameTier
  readonly state:
    | 'pending'
    | 'ok'
    | 'denied'
    | 'blocked'
    | 'running'
    | 'failed'
    | 'skipped'
    | 'incident'
    | 'cancelled'
  /** plan 节点的计划 ID（kind='plan' 时存在）。 */
  readonly planId?: string
  /** plan 节点的失败/跳过理由码（与 `plan/node-result.code` 同源）。 */
  readonly code?: string
}

/** DAG 边（有向：先 → 后）。 */
export interface DagEdge {
  readonly from: string
  readonly to: string
}

/** DAG（按 turn 整体替换）。 */
export interface DagFrame {
  readonly kind: 'dag'
  readonly seq: number
  readonly at: number
  readonly turn: number
  readonly nodes: readonly DagNode[]
  readonly edges: readonly DagEdge[]
  /** 文字摘要（SVG 的 `aria-label` 用它，屏幕阅读器不能只看到一张空图）。 */
  readonly summary: string
}

/** 全量快照（连接 / 重同步）。 */
export interface SnapshotFrame {
  readonly kind: 'snapshot'
  readonly sessionId: string
  readonly maxSeq: number
  readonly frames: readonly WebFrame[]
}

/** 全部帧。 */
export type WebFrame =
  | TurnFrame
  | MessageFrame
  | DeltaFrame
  | ToolFrame
  | ApprovalFrame
  | ApprovalClosedFrame
  | NoticeFrame
  | AuditFrame
  | DagFrame
  | SnapshotFrame

/** 帧的稳定键：同一键的新帧**替换**旧帧（不追加），这是三态与 DAG 更新的基础。 */
export function frameKey(frame: WebFrame): string {
  switch (frame.kind) {
    case 'turn':
      return `turn:${String(frame.turn)}:${frame.phase}`
    case 'message':
      return `message:${String(frame.seq)}`
    case 'delta':
      return `delta:${String(frame.at)}`
    case 'tool':
      return `tool:${frame.callId}`
    case 'approval':
      return `approval:${frame.ticketId}`
    case 'approval-closed':
      return `approval-closed:${frame.ticketId}`
    case 'notice':
      return `notice:${String(frame.seq)}`
    case 'audit':
      return `audit:${String(frame.seq)}`
    case 'dag':
      return `dag:${String(frame.turn)}`
    case 'snapshot':
      return 'snapshot'
    default:
      return assertNever(frame, 'web-frame')
  }
}

/** 帧的 `seq`（`delta` / `snapshot` 没有）。 */
export function frameSeq(frame: WebFrame): number | undefined {
  switch (frame.kind) {
    case 'delta':
    case 'snapshot':
      return undefined
    default:
      return frame.seq
  }
}
