/**
 * 渠道能力位的**单一实现点**。
 *
 * WHY 单独成文件：能力位有三类消费方——适配器返回它、host 的 `/api/session` 上报它
 * （`web/handlers/session.ts`）、前端壳按它降级渲染。定义留在 `web/adapter.ts` 时，
 * `mobile` 适配器就必须 import `web`，形成"移动依赖网页"的假耦合，门禁也无法用单点判据校验。
 * 纪律：本文件**只有类型与常量**，不含推导逻辑（与 `frames.ts` 同款分工）。
 */

import type { ChannelKind } from '@bah/runtime'

/**
 * 渠道标识。**不新造联合**：`ChannelKind`（`runtime/src/system-prompt/types.ts`）已是六渠道
 * 的权威定义，`CHANNEL_HINTS`（`sections.ts`）与 host 的 `CHANNELS`（`plugins/agent.ts`）
 * 都穷尽了它。再写一份就是第二真相源。
 *
 *  V2：`ChannelAdapter.id` 原先是 `'web'|'mobile'|'im'|'desktop'|'cli'`
 * ——多一个 `cli`（全库无任何适配器使用）、少 `headless`/`sdk`（配置面却在用 `channel: headless`）。
 * 本设计把它收敛为 `ChannelKind`：这是**修错位**，不是改签。
 */
export type ChannelId = ChannelKind

/**
 * 渠道能力位（10 字段，00 D4 原文）。前 5 个是"能不能承接某种呈现"，后 5 个是"用什么形态承接"
 * ——后者是移动端与桌面端的**结构差异**（00 D1 否决纯响应式单壳的理由），必须由渠道如实声明，
 * 前端不得反过来猜。
 */
export interface ChannelCapabilities {
  readonly richCards: boolean
  readonly buttons: boolean
  readonly forms: boolean
  readonly images: boolean
  /** 是否支持流式增量（Web = true；IM 卡片 = false）。 */
  readonly streaming: boolean
  /** 布局口径：宽屏双列 / 窄屏单列。 */
  readonly layout: 'wide' | 'narrow'
  /** 审批呈现面：桌面弹窗 / 移动底部抽屉。 */
  readonly approvalSurface: 'dialog' | 'bottom-sheet'
  /** 是否支持滑动确认（呈现层防误触，**不是**鉴权，00 D11）。 */
  readonly gestureConfirm: boolean
  /**
   * 语音输入路径：`'ime'` = 走系统输入法听写（页面不采集音频）/ `'in-page'` = 页面内识别
   * （**本轮不用**）/ `'none'` = 无语音入口。见 00 D10（2026-10-29 二次定稿）。
   */
  readonly voiceInput: 'ime' | 'in-page' | 'none'
  /** DAG 呈现：图形 / 分步清单。 */
  readonly dagView: 'graph' | 'steps'
}

/** Web：全量呈现 + 宽屏双列 + 弹窗审批 + 图形 DAG。后五项是**现状如实上报**，不是待开占位。 */
export const WEB_CAPABILITIES: ChannelCapabilities = {
  richCards: true,
  buttons: true,
  forms: true,
  images: true,
  streaming: true,
  layout: 'wide',
  approvalSurface: 'dialog',
  gestureConfirm: false,
  voiceInput: 'none',
  dagView: 'graph',
}

/**
 * 移动 H5（00 D4 指定的五项差异）。`voiceInput:'ime'` 的含义：渠道声明"语音走**系统输入法**"
 * ——IME 听写的音频采集发生在操作系统/输入法层，网页只从 `input` 事件拿到**文本**，
 * **不申请麦克风权限**、不调用 `getUserMedia`、不构造 `SpeechRecognition` ⇒ 不受
 * `Permissions-Policy: microphone` 约束（00 D10 · 2026-10-29 二次定稿）。
 * `web/http.ts` 的 `permissions-policy` **逐字不动**，并由门禁 I10 钉死（任何改动即红）。
 * 页面侧的 IME 适配（输入框属性、`composition*` 组合态、可关提示、快捷短语 chips）全归 ，
 * 本设计没有任何语音相关的实现工作。
 */
export const MOBILE_CAPABILITIES: ChannelCapabilities = {
  richCards: true,
  buttons: true,
  forms: true,
  images: true,
  streaming: true,
  layout: 'narrow',
  approvalSurface: 'bottom-sheet',
  gestureConfirm: true,
  voiceInput: 'ime',
  dagView: 'steps',
}

/**
 * 以下四个是**占位常量**（适配器与 profile 不在本设计；门禁 I2 只查常量表穷尽，I4 只查 mobile）：
 * IM = 卡片可、表单不可、无流式（一条消息一屏）；desktop = 与 Web 同呈现 + 滑动确认（桌面壳
 * 不提供语音入口 ⇒ `voiceInput:'none'`）；headless = 无人在回路 ⇒ 一切呈现关闭
 * （`profiles/headless/patch.yml` 的 `channel: headless` 的如实描述：它没有前端，能力位只被
 * 提示词裁剪读到）；sdk = 结构化全开，审批由集成方承接。
 */
export const IM_CAPABILITIES: ChannelCapabilities = {
  richCards: true,
  buttons: true,
  forms: false,
  images: true,
  streaming: false,
  layout: 'narrow',
  approvalSurface: 'bottom-sheet',
  gestureConfirm: false,
  voiceInput: 'none',
  dagView: 'steps',
}

/** 桌面壳：与 Web 同呈现，另加滑动确认；不提供语音入口。 */
export const DESKTOP_CAPABILITIES: ChannelCapabilities = {
  ...WEB_CAPABILITIES,
  gestureConfirm: true,
  voiceInput: 'none',
}

/** 无头：无人在回路，一切呈现关闭。 */
export const HEADLESS_CAPABILITIES: ChannelCapabilities = {
  richCards: false,
  buttons: false,
  forms: false,
  images: false,
  streaming: false,
  layout: 'narrow',
  approvalSurface: 'dialog',
  gestureConfirm: false,
  voiceInput: 'none',
  dagView: 'steps',
}

/** SDK：结构化全开；审批由集成方承接，页面不在本工程内。 */
export const SDK_CAPABILITIES: ChannelCapabilities = {
  ...WEB_CAPABILITIES,
  gestureConfirm: false,
}

/**
 * 渠道 ⇒ 能力位。用 `Record<ChannelId, …>` 而不是对象字面量：新增 `ChannelKind` 成员时
 * **编译期**就红——这是"6 渠道穷尽"的第一道闸；门禁 I2 是第二道（运行期比对）。
 */
export const CAPABILITIES_BY_CHANNEL: Record<ChannelId, ChannelCapabilities> = {
  web: WEB_CAPABILITIES,
  mobile: MOBILE_CAPABILITIES,
  im: IM_CAPABILITIES,
  desktop: DESKTOP_CAPABILITIES,
  headless: HEADLESS_CAPABILITIES,
  sdk: SDK_CAPABILITIES,
}

/** 取一个渠道的能力位（入参类型已收窄，表外值不可能）。 */
export function capabilitiesOf(channel: ChannelId): ChannelCapabilities {
  return CAPABILITIES_BY_CHANNEL[channel]
}
