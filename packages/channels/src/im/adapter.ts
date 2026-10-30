/**
 * IM 渠道适配器（施工单 01 §2.2）。**薄工厂**：与 web/mobile 的差异只有 `id` 与 `capabilities`。
 *
 * WHY 不允许在这里写第二份 `decide` / `verify`：审批语义只有 `http-adapter.ts` 一份实现
 * （总纲 I-IM-15）。IM 的审批走文本指令与 H5，但**结论的判定**仍然进同一个适配器——
 * 分叉一份就是给"绕过红级强验证"开后门。
 */

import type { ChannelId } from '../capabilities.ts'
import { IM_CAPABILITIES } from '../capabilities.ts'
import {
  createHttpChannelAdapter,
  type HttpChannelAdapter,
  type HttpChannelAdapterOptions,
} from '../http-adapter.ts'

/** IM 渠道 id（唯一字面量落点，门禁 I5 据此与 profile 对账）。 */
export const IM_CHANNEL_ID: ChannelId = 'im'

/** IM 渠道适配器（`id` 收窄成 `'im'`，便于 host 侧类型判定）。 */
export type ImChannelAdapter = HttpChannelAdapter & { readonly id: 'im' }

/** 造一个 IM 渠道适配器。`sessionId` 语义与 web/mobile 完全一致（归属校验，W04）。 */
export function createImChannelAdapter(
  options: { readonly sessionId?: string } = {},
): ImChannelAdapter {
  const adapter = createHttpChannelAdapter({
    id: IM_CHANNEL_ID,
    capabilities: IM_CAPABILITIES,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  } satisfies HttpChannelAdapterOptions)
  return adapter as ImChannelAdapter
}
