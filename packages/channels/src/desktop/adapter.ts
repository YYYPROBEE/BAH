/**
 * 桌面渠道适配器（施工单 15 §2 / 桌面端 01）。**薄工厂**：与 Web 的差异只有 `id` 与 `capabilities`。
 *
 * WHY 不允许在这里写第二份 decide/verify/attachApproval：桌面壳内嵌的是同一个私有宿主，
 * 审批语义一旦分叉，桌面端就成了"绕过 Web 加固"的旁路（00 D2 的理由原文，对桌面端同样成立）。
 *
 * 与 mobile 的差别只有一处：`DESKTOP_CAPABILITIES` 不是新的一组值，而是
 * `{ ...WEB_CAPABILITIES, gestureConfirm: true, voiceInput: 'none' }`——桌面与 Web 共用同一份
 * 呈现能力，只多"滑动确认"、少"语音入口"（桌面壳不提供麦克风入口）。
 */

import type { ChannelId } from '../capabilities.ts'
import { DESKTOP_CAPABILITIES } from '../capabilities.ts'
import {
  createHttpChannelAdapter,
  type HttpChannelAdapter,
  type HttpChannelAdapterOptions,
} from '../http-adapter.ts'

/** 桌面渠道 id（唯一字面量落点，门禁 I5 据此与 profile 对账）。 */
export const DESKTOP_CHANNEL_ID: ChannelId = 'desktop'

/** 桌面渠道适配器（`id` 收窄成 `'desktop'`，便于 host 侧类型判定）。 */
export type DesktopChannelAdapter = HttpChannelAdapter & { readonly id: 'desktop' }

/** 造一个桌面渠道适配器。`sessionId` 语义与 Web 完全一致（归属校验，W04）。 */
export function createDesktopChannelAdapter(
  options: { readonly sessionId?: string } = {},
): DesktopChannelAdapter {
  const adapter = createHttpChannelAdapter({
    id: DESKTOP_CHANNEL_ID,
    capabilities: DESKTOP_CAPABILITIES,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  } satisfies HttpChannelAdapterOptions)
  return adapter as DesktopChannelAdapter
}
