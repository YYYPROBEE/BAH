/**
 * `@bah/channels` · 逻辑模块 web（施工单 13）。
 *
 * 这里只有**渠道无关的投影与转换**：帧模型、归约器、session-follow、审批翻译、渠道适配器。
 * HTTP / SSE / 静态资源在宿主插件（`@bah/host` 的 `channel:web`），DOM 在 `apps/web`。
 */

export type {
  ApprovalClosedFrame,
  ApprovalFrame,
  AuditFrame,
  CardField,
  CardTable,
  CardView,
  DagEdge,
  DagFrame,
  DagNode,
  DeltaFrame,
  FrameTag,
  FrameTier,
  FrameTone,
  MessageBlock,
  MessageFrame,
  NoticeFrame,
  SnapshotFrame,
  TagTone,
  ToolFrame,
  TurnFrame,
  WebFrame,
} from './frames.ts'
export { frameKey, frameSeq } from './frames.ts'

export type { CardInput } from './cards.ts'
export { blocksToText, buildCard, toolTitle } from './cards.ts'

export type { FollowDecision, FollowOptions } from './follow.ts'
export { DEFAULT_FOLLOW_BUFFER_LIMIT, SessionFollow } from './follow.ts'

export type {
  ApprovalViewLike,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelMessage,
  DecideResult,
  InboundInput,
  WebChannelAdapter,
} from './adapter.ts'
export { createWebChannelAdapter } from './adapter.ts'

export { WebProjector, decisionLabel, deltaFrame, projectSession } from './project.ts'
export {
  amountFromArgs,
  amountText,
  extractDisclaimer,
  isAmountConfirmed,
  payeeFromArgs,
} from './amount.ts'
export { formatCents, shortId, timeText, yuanToCents } from './format.ts'
export { DagBuilder } from './dag.ts'
export { auditOf } from './audit.ts'
