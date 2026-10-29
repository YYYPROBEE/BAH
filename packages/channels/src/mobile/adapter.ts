/**
 * 移动 H5 渠道适配器（施工单 01）。**薄工厂**：与 Web 的差异只有 `id` 与 `capabilities`。
 *
 * WHY 不允许在这里写第二份 decide/verify：审批语义一旦分叉，移动端就成了"绕过桌面端加固"
 * 的旁路（00 D2 的理由原文）。
 */

import type { ChannelId } from '../capabilities.ts'
import { MOBILE_CAPABILITIES } from '../capabilities.ts'
import {
  createHttpChannelAdapter,
  type HttpChannelAdapter,
  type HttpChannelAdapterOptions,
} from '../http-adapter.ts'

/** 移动渠道 id（唯一字面量落点，门禁 I5 据此与 profile 对账）。 */
export const MOBILE_CHANNEL_ID: ChannelId = 'mobile'

/** 移动渠道适配器（`id` 收窄成 `'mobile'`，便于 host 侧类型判定）。 */
export type MobileChannelAdapter = HttpChannelAdapter & { readonly id: 'mobile' }

/** 造一个移动 H5 渠道适配器。`sessionId` 语义与 Web 完全一致（归属校验，W04）。 */
export function createMobileChannelAdapter(
  options: { readonly sessionId?: string } = {},
): MobileChannelAdapter {
  const adapter = createHttpChannelAdapter({
    id: MOBILE_CHANNEL_ID,
    capabilities: MOBILE_CAPABILITIES,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  } satisfies HttpChannelAdapterOptions)
  return adapter as MobileChannelAdapter
}
