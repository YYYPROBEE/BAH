/**
 * 微信 `PlatformAdapter` 实现。
 *
 * 边界（§2.8 原文）：
 * - 适配器**不**决定 ack 文案、**不**决定审批语义；它只负责"验签 / 解包 / 编码 / 传输"；
 * - `passive` 只能承载一条文本（公众号被动回复的协议限制）：多个出站以 `\n` 合并，
 *   超过 `maxTextBytes` 时只回第一片，其余由网关走 `push`；
 * - `push` 才允许分片（客服消息逐条发送）；
 * - 网络 I/O 只在 `pushText` 这个注入依赖里——`verify` / `parse` 是纯函数。
 */

import { BahError } from '@bah/util'

import { outboundText, type PlatformAdapter, type PlatformParseResult, type PlatformPushResult, type PlatformReply, type PlatformRequest, type PlatformResponse, type PlatformVerdict } from '../platform.ts'
import type { ImOutbound } from '../render.ts'
import { encodePassiveText, prefixChunks, splitTextByBytes, WECHAT_TEXT_MAX_BYTES } from './outbound.ts'
import { verifyWechatSignature } from './signature.ts'
import { parseWechatXml } from './xml.ts'

/** 适配器依赖（全部可注入：测试用假 API / 假时钟）。 */
export interface WechatAdapterDeps {
  readonly accountKey: string
  readonly token: string
  readonly appId: string
  readonly appSecret: string
  readonly apiBase: string
  /** 注入钟（epoch 秒）。被动回复的 `CreateTime` 与验签都读它。 */
  readonly nowSec: () => number
  /** 客服消息发送（网关装配 `transport.ts`；契约测试注入记录器）。 */
  readonly pushText: (userId: string, text: string) => Promise<PlatformPushResult>
}

/** 微信能力位（§2.8 的固定值；契约测试逐字段断言）。 */
const WECHAT_CAPABILITIES = {
  passiveReply: true,
  asyncPush: true,
  interactiveCards: false,
  threads: false,
  maxTextBytes: WECHAT_TEXT_MAX_BYTES,
} as const

/** 平台回复的固定头。 */
const XML_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/xml; charset=utf-8' }
const TEXT_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'text/plain; charset=utf-8' }

/** 微信要求"收到但不处理"时回的字面量（回空串也行，`success` 更可诊断）。 */
const ACK_BODY = 'success'

/**
 * 造一个微信适配器。
 *
 * @param deps 见 {@link WechatAdapterDeps}
 */
export function createWechatAdapter(deps: WechatAdapterDeps): PlatformAdapter {
  /** 验签（`verify` 与 GET 挑战都走它，避免两条路径各自解释签名）。 */
  const verifySignature = (request: PlatformRequest, nowSec: number): PlatformVerdict => {
    const verdict = verifyWechatSignature({
      token: deps.token,
      signature: request.query['signature'] ?? '',
      timestamp: request.query['timestamp'] ?? '',
      nonce: request.query['nonce'] ?? '',
      nowSec,
    })
    if (verdict.ok) return { ok: true }
    return { ok: false, status: 401, code: `im-sig-${verdict.code}` }
  }

  return {
    id: 'wechat',
    capabilities: WECHAT_CAPABILITIES,

    verify: verifySignature,

    parse(request, _nowSec): PlatformParseResult {
      if (request.method === 'GET') {
        // 公众号后台"保存回调配置"时的握手：验签通过后原样回显 echostr。
        const echo = request.query['echostr']
        if (echo === undefined || echo.length === 0) {
          return { kind: 'reject', status: 400, code: 'im-challenge-missing' }
        }
        const verdict = verifySignature(request, _nowSec)
        if (!verdict.ok) return { kind: 'reject', status: verdict.status, code: verdict.code }
        return { kind: 'challenge', response: { status: 200, headers: TEXT_HEADERS, body: echo } }
      }

      let inbound
      try {
        inbound = parseWechatXml(request.body)
      } catch (error) {
        const code = error instanceof BahError ? error.code : 'im-xml-invalid'
        // 超长报文给 413：与"报文不合法"（400）区分开，运维一眼能看出是哪个上限被撞了。
        return { kind: 'reject', status: code === 'im-xml-too-large' ? 413 : 400, code }
      }

      if (inbound.kind !== 'text') {
        // 事件（关注/取关/菜单）与非文本消息：不跑 turn，回 success。
        return {
          kind: 'unsupported',
          response: { status: 200, headers: TEXT_HEADERS, body: ACK_BODY },
        }
      }

      return {
        kind: 'message',
        inbound: {
          platform: 'wechat',
          accountKey: deps.accountKey,
          userId: inbound.fromUser,
          text: inbound.content,
          ...(inbound.msgId === undefined ? {} : { messageId: inbound.msgId }),
          at: inbound.createTime * 1000,
        },
        reply: createReply(deps, inbound.toUser, inbound.fromUser),
      }
    },
  }
}

/** 一条消息的双出口（闭包只持有本次会话的两个平台 ID + openid）。 */
function createReply(deps: WechatAdapterDeps, publicId: string, openid: string): PlatformReply {
  const success = (): PlatformResponse => ({ status: 200, headers: TEXT_HEADERS, body: ACK_BODY })

  return {
    passive(outbounds: readonly ImOutbound[]): PlatformResponse {
      const merged = outbounds
        .map(outboundText)
        .filter((text) => text.trim().length > 0)
        .join('\n')
      if (merged.length === 0) return success()

      const first = splitTextByBytes(merged, WECHAT_TEXT_MAX_BYTES)[0] ?? ''
      if (first.length === 0) return success()
      // 收发件人对调：`ToUserName` 是用户 openid，`FromUserName` 是公众号原始 ID
      return {
        status: 200,
        headers: XML_HEADERS,
        body: encodePassiveText({
          toUser: openid,
          fromUser: publicId,
          content: first,
          nowSec: deps.nowSec(),
        }),
      }
    },

    async push(outbounds: readonly ImOutbound[]): Promise<PlatformPushResult> {
      for (const outbound of outbounds) {
        const text = outboundText(outbound)
        if (text.trim().length === 0) continue
        const chunks = prefixChunks(splitTextByBytes(text, WECHAT_TEXT_MAX_BYTES), WECHAT_TEXT_MAX_BYTES)
        for (const chunk of chunks) {
          const result = await deps.pushText(openid, chunk)
          // 任一条失败立即返回：继续发只会把同一份错误重复给平台，且用户看到的是半截结果。
          if (!result.ok) return result
        }
      }
      return { ok: true }
    },
  }
}
