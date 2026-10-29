/**
 * Web 渠道适配器（施工单 13 §1）——**薄工厂**（施工单 01 §3.2 瘦身）。
 *
 * 历史：本文件原先承载 238 行的完整实现（入站转换 / 审批翻译 / 强验证）。
 * 01 单把与渠道身份无关的部分整段平移到 `../http-adapter.ts`，与 mobile 共用一份实现
 * （00 D2：安全面只有一份实现才可被门禁与复审覆盖）。本文件只剩"web 是哪两个常量"。
 *
 * 仍然不做的事：不碰 HTTP / SSE（宿主插件 `channel:web`）、不碰 DOM（`apps/web`）、
 * 不推导业务（`web/project.ts` 的纯归约）。
 */

import type { ChannelCapabilities } from '../capabilities.ts'
import { WEB_CAPABILITIES } from '../capabilities.ts'
import {
  createHttpChannelAdapter,
  type HttpChannelAdapter,
  type HttpChannelAdapterOptions,
} from '../http-adapter.ts'

/**
 * Web 渠道的公开面。
 *
 * @deprecated 施工单 01 起请用 `HttpChannelAdapter`（web 与 mobile 共用的公开面）。
 * 本别名只为不破既有 import（`web/deps.ts`、`dispatch.test.ts`、`plugins/web.ts`）而保留，
 * 限期到 02 单合并后删除。
 */
export type WebChannelAdapter = HttpChannelAdapter & { readonly id: 'web' }

/** Web 渠道 id（唯一字面量落点）。 */
export const WEB_CHANNEL_ID = 'web' as const

/**
 * 造一个 Web 渠道适配器。
 *
 * `sessionId` 语义不变（W04 归属校验）：生产必须传，否则一个有效 token 就能拿别的会话的
 * 票据 ID 去批钱。
 */
export function createWebChannelAdapter(options: {
  /**
   * 本渠道所属会话（缺省 = 不校验归属）。
   *
   * 生产必须传：审批视图来自 `ApprovalService`，它的 `sessionId` 必须与这里一致；
   * 否则一个有效 token 就能拿别的会话的票据 ID 去批钱（W04 TC-02）。
   */
  readonly sessionId?: string
} = {}): WebChannelAdapter {
  const adapter = createHttpChannelAdapter({
    id: WEB_CHANNEL_ID,
    capabilities: WEB_CAPABILITIES,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  } satisfies HttpChannelAdapterOptions)
  return adapter as WebChannelAdapter
}

/**
 * 公开类型的再导出（既有 import 路径 `./adapter.ts` 不破）。
 *
 * ⚠ `ChannelCapabilities` 从 `../capabilities.ts` 出、其余从 `../http-adapter.ts` 出：
 * 两处口径单一，本文件不留第二份定义。
 */
export type {
  ApprovalViewLike,
  ChallengeViewLike,
  ChannelAdapter,
  ChannelMessage,
  DecideResult,
  InboundInput,
  VerifyResult,
} from '../http-adapter.ts'
export type { ChannelCapabilities } from '../capabilities.ts'
