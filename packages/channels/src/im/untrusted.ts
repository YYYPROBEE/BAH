/**
 * IM 入站文本的 untrusted 双判据。
 *
 * WHY 需要两条判据而不是一条：
 * - `user`：运维在环境变量里点名了"这个平台用户不可信"（如转发的第三方账号）；
 * - `marker`：用户自己在消息开头写 `【转发】`，声明"下面是别人说的话"。
 *
 * **不得全量标记**：把每条 IM 消息都标成 untrusted 会让"查余额/转账"这类正常诉求被
 * 提示词降权，助手变得不可用。只有命中才加前缀，这是能用与不能用的分界。
 *
 * 前缀的唯一定义点在 `@bah/safety`（`IM_UNTRUSTED_PREFIX`）：注册的 `im.untrusted`
 * 提示词段解释的就是这串字符。这里**不复制**常量——两处各写一份，段解释与标记就会漂移。
 */

import { markUntrustedIm } from '@bah/safety'

/** 用户自述的转发标记（中文括号，全角，与 IM 里常见的"转发"格式一致）。 */
export const IM_FORWARD_MARKER = '【转发】'

/** 判定输入。 */
export interface ImUntrustedInput {
  readonly platform: string
  readonly userId: string
  readonly text: string
  /** 环境变量解析后的集合，元素形如 `wechat:oX1`。 */
  readonly users: ReadonlySet<string>
}

/** 判定结果（`text` 已是"可直接发给模型"的最终文本）。 */
export interface ImInboundPrepared {
  readonly text: string
  readonly untrusted: boolean
  readonly reason?: 'user' | 'marker'
}

/**
 * 给一条入站文本打 untrusted 判定。
 *
 * - 命中名单 → 打标记，`reason='user'`；
 * - 以 `【转发】` 开头 → 去前缀后打标记，`reason='marker'`；
 * - 其余 → 原样返回（**不**标记）。
 */
export function prepareImInbound(input: ImUntrustedInput): ImInboundPrepared {
  if (input.users.has(`${input.platform}:${input.userId}`)) {
    return { text: markUntrustedIm(input.text), untrusted: true, reason: 'user' }
  }
  if (input.text.startsWith(IM_FORWARD_MARKER)) {
    const body = input.text.slice(IM_FORWARD_MARKER.length).trim()
    return { text: markUntrustedIm(body), untrusted: true, reason: 'marker' }
  }
  return { text: input.text, untrusted: false }
}
