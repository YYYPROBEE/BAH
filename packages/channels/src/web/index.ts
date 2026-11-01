/**
 * `@bah/channels` · 逻辑模块 web（施工单 13）。
 *
 * 这里只有**渠道无关的投影与转换**：帧模型、归约器、session-follow、审批翻译、渠道适配器。
 * HTTP / SSE / 静态资源在宿主插件（`@bah/host` 的 `channel:web`），DOM 在 `apps/web`。
 */

export type {
  ApprovalClosedFrame,
  ApprovalDetail,
  ApprovalFrame,
  AuditFrame,
  CardField,
  CardTable,
  CardView,
  ChoiceFrame,
  ChoiceOption,
  DagEdge,
  DagFrame,
  DagNode,
  DeltaFrame,
  EffectItem,
  EffectsFrame,
  FrameTag,
  FrameTier,
  FrameTone,
  GoalFrame,
  MessageBlock,
  MessageFrame,
  NoticeFrame,
  SnapshotFrame,
  TagTone,
  TodoFrame,
  TodoItem,
  ToolFrame,
  TurnFrame,
  WebFrame,
} from './frames.ts'
export { frameKey, frameSeq } from './frames.ts'

export type { CardInput } from './cards.ts'
export { blocksToText, buildCard, toolTitle } from './cards.ts'

export type { FollowDecision, FollowOptions } from './follow.ts'
export { DEFAULT_FOLLOW_BUFFER_LIMIT, SessionFollow } from './follow.ts'

// 施工单 01：适配器实现平移到 ../http-adapter.ts、能力位定义平移到 ../capabilities.ts。
// 这里从**新源头**再导出（不是从 ./adapter.ts），否则同一符号会经两条路径进顶层 barrel。
export type {
  ApprovalViewLike,
  ChallengeViewLike,
  ChannelAdapter,
  ChannelMessage,
  DecideResult,
  HttpChannelAdapter,
  InboundInput,
  VerifyResult,
} from '../http-adapter.ts'
export type { ChannelCapabilities, ChannelId } from '../capabilities.ts'
export { CAPABILITIES_BY_CHANNEL, capabilitiesOf } from '../capabilities.ts'
export { createWebChannelAdapter } from './adapter.ts'
export type { WebChannelAdapter } from './adapter.ts'

export type { WebProjectorOptions } from './project.ts'
export {
  DETAILS_MAX_ROWS,
  WebProjector,
  decisionLabel,
  deltaFrame,
  projectApprovalDetails,
  projectEffects,
  projectSession,
  projectTodo,
} from './project.ts'
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
export type { AaBlock, AaParticipantProgress, AaProgress } from './aa.ts'
export {
  AA_HEADERS,
  AA_MAX_ROWS,
  AA_STATE_LABEL,
  aaBlockOf,
  aaFromResult,
  applyCollected,
  applyParticipantUpdated,
} from './aa.ts'
export type { AaParticipantState } from './aa.ts'
export type { SnapshotItem, SubscriptionSnapshot, UpcomingBlock } from './subscriptions.ts'
export {
  UPCOMING_LIMIT,
  UPCOMING_WINDOW_DAYS,
  dateText,
  snapshotOf,
  upcomingBlockOf,
} from './subscriptions.ts'
// ADR-0016：主动提醒载荷 → `notice` 帧（被预算压掉的返回 undefined）
export { proactiveNoticeOf } from './proactive.ts'
