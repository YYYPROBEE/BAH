/**
 * IM 平台的**唯一契约定义点**。
 *
 * WHY 单独成文件：`PlatformAdapter` 是网关与平台实现之间唯一的缝——网关只认它，
 * 微信/Mock 各自实现它。契约一旦被复制到 `apps/im-gateway`，平台的差异就会在
 * 两份类型里各说各话（02 门禁 G13 把这条钉成机器判据）。
 *
 * 纪律：
 * - 本文件只有**类型**，不含 I/O、不含日志、不含全局状态；
 * - `verify` / `parse` 必须是纯函数（给定同一份请求与同一时刻，结论相同）；
 * - 唯一允许的网络 I/O 在 `PlatformReply.push` 的注入依赖里（网关负责装配）；
 * - `ImOutbound` 定义在 `render.ts`，这里**复用**，不另立第二份（01 §2.4）。
 */

import type { ImOutbound } from './render.ts'

/** 平台能力位：回答"这个平台能不能做某件事"，不是渠道呈现口径（那是 `ChannelCapabilities`）。 */
export interface PlatformCapabilities {
  /** 能否在 HTTP 响应里同步回消息（公众号被动回复：能）。 */
  readonly passiveReply: boolean
  /** 能否异步主动推送（公众号客服消息：视权限而定）。 */
  readonly asyncPush: boolean
  /** 交互卡片（含按钮回调）；公众号 false。 */
  readonly interactiveCards: boolean
  /** 话题/线程隔离；公众号 false。 */
  readonly threads: boolean
  /** 单条文本上限（字节；微信 2048）。 */
  readonly maxTextBytes: number
}

/** 一条已解析的平台入站消息（平台无关形态）。 */
export interface ImInbound {
  /** 平台 id（`'wechat' | 'mock'`）。 */
  readonly platform: string
  /** 账号隔离键；单账号部署写 `'default'`。 */
  readonly accountKey: string
  /** 平台用户标识（微信 openid）。**不得落日志、不得进路径**（I-IM-05）。 */
  readonly userId: string
  readonly text: string
  /** 平台消息 ID（去重键的第三段；有的平台没有）。 */
  readonly messageId?: string
  /** 到达时刻（epoch ms，由网关在解析时补，平台可缺）。 */
  readonly at: number
}

/** 平台原始请求的只读映射（网关只做最小解包，不解析平台字段）。 */
export interface PlatformRequest {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string | undefined>>
  /** 原始报文（XML / JSON；解析归适配器）。 */
  readonly body: string
}

/** 平台响应（被动回复 / 挑战应答 / 不支持时的说明）。 */
export interface PlatformResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** 验签结论。 */
export type PlatformVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly code: string }

/** 解析结论：一条消息 / 平台挑战握手 / 不支持但合法 / 拒绝。 */
export type PlatformParseResult =
  | { readonly kind: 'message'; readonly inbound: ImInbound; readonly reply: PlatformReply }
  | { readonly kind: 'challenge'; readonly response: PlatformResponse }
  | { readonly kind: 'unsupported'; readonly response: PlatformResponse }
  | { readonly kind: 'reject'; readonly status: number; readonly code: string }

/**
 * 一条消息的**双出口**。
 *
 * `passive` 是同步响应（公众号被动回复，5 秒窗口内必须返回）；
 * `push` 是异步推送（客服消息）。适配器只发送 `ImOutbound.text`，不解析审批语义。
 */
export interface PlatformReply {
  passive(outbounds: readonly ImOutbound[]): PlatformResponse
  push(outbounds: readonly ImOutbound[]): Promise<PlatformPushResult>
}

/** 异步推送结论（失败要结构化：网关据此决定降级到"拉取式"）。 */
export type PlatformPushResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: 'unavailable' | 'expired-window' | 'quota' | 'unauthorized' | 'failed'
      readonly reason: string
    }

/** 一个平台适配器（微信与 Mock 实现同一契约，跑同一套契约测试）。 */
export interface PlatformAdapter {
  /** 平台 id（进 `ImInbound.platform`，也是注册表的键）。 */
  readonly id: string
  readonly capabilities: PlatformCapabilities
  verify(request: PlatformRequest, nowSec: number): PlatformVerdict
  parse(request: PlatformRequest, nowSec: number): PlatformParseResult
}

/**
 * 出站消息的**唯一文本面**（02 §2.2 的规则落地：适配器只发 `.text`）。
 *
 * WHY 需要一个函数而不是各处写 `outbound.text`：`approval` / `handoff` 是**渠道内**的结构
 * （携带票据号、层级、截止时刻），平台报文只承载人可读文本。把取值收成一处，
 * 未来新增出站种类时"哪些字段能进平台报文"只有这里需要复核。
 */
export function outboundText(outbound: ImOutbound): string {
  return outbound.text
}
