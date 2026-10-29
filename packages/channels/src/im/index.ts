/**
 * `@bah/channels` · 逻辑模块 im（施工单 01 起为真实实现）。
 *
 * 这里只有**平台无关**的部分：平台契约、会话键、帧投影、审批指令、渠道薄工厂。
 * 微信协议（验签 / XML / 出站编码）在 02 单的 `im/protocol/`；公网网关在 `apps/im-gateway`。
 *
 * 纪律：本文件是**纯 barrel**（只 re-export），登记在 `scripts/barrel-excludes.ts`。
 */

export type { ImChannelAdapter } from './adapter.ts'
export { IM_CHANNEL_ID, createImChannelAdapter } from './adapter.ts'

export type { ImCommand } from './commands.ts'
export { IM_COMMAND_MAX_REASON, IM_TICKET_ID_PATTERN, parseImCommand } from './commands.ts'

export type {
  ImInbound,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformParseResult,
  PlatformPushResult,
  PlatformReply,
  PlatformRequest,
  PlatformResponse,
  PlatformVerdict,
} from './platform.ts'
export { outboundText } from './platform.ts'

export type { ImOutbound } from './render.ts'
export { projectImOutbound } from './render.ts'

export { IM_SESSION_ID_PATTERN, assertImSessionId, deriveImSessionId } from './session.ts'
