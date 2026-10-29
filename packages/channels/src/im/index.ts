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

// 02 单：微信协议纯函数（验签 / XML / 出站编码）+ 微信适配器 + untrusted 双判据。
// 不建 `protocol/index.ts`：barrel 多一层就要多一条登记，且平台实现只有微信一份。
export { WECHAT_SIGNATURE_WINDOW_SEC } from './protocol/signature.ts'
export {
  computeWechatSignature,
  verifyWechatSignature,
  type SignatureVerdict,
  type WechatSignatureInput,
} from './protocol/signature.ts'
export { WECHAT_XML_MAX_BYTES, parseWechatXml, type WechatInbound } from './protocol/xml.ts'
export {
  cdata,
  encodePassiveText,
  prefixChunks,
  splitTextByBytes,
  WECHAT_TEXT_MAX_BYTES,
  type PassiveTextInput,
} from './protocol/outbound.ts'
export { createWechatAdapter, type WechatAdapterDeps } from './protocol/wechat-adapter.ts'
// 03 单：H5 审批链接（网关与 H5 页共用同一份签名实现，不复制）。
export {
  APPROVAL_LINK_MAX_TTL_MS,
  APPROVAL_LINK_SECRET_MIN,
  APPROVAL_LINK_VERSION,
  signApprovalLink,
  verifyApprovalLink,
  type ApprovalLinkPayload,
  type ApprovalLinkVerdict,
} from './protocol/link-token.ts'
export {
  IM_FORWARD_MARKER,
  prepareImInbound,
  type ImInboundPrepared,
  type ImUntrustedInput,
} from './untrusted.ts'
