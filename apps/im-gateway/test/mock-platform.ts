/**
 * Mock 平台适配器（施工单 02 §2.14）——**仅测试**。
 *
 * 存在的唯一目的：让 `PlatformAdapter` 契约能被**两个实现**同时跑同一套断言。
 * 只有一个实现时，"契约"退化成"微信的形状"；有两个实现，契约才是真的契约。
 *
 * **不进生产**：本文件在 `test/` 下，`src/main.ts` 不 import 它；门禁 G11/G12 钉死。
 */

import { outboundText, type ImInbound, type ImOutbound, type PlatformAdapter, type PlatformParseResult, type PlatformPushResult, type PlatformRequest, type PlatformResponse, type PlatformVerdict } from '@bah/channels'

/** mock 的固定能力位（与微信相同，便于契约逐字段比对）。 */
const MOCK_CAPABILITIES = {
  passiveReply: true,
  asyncPush: true,
  interactiveCards: false,
  threads: false,
  maxTextBytes: 2048,
} as const

/** mock 的可观测状态（测试断言用）。 */
export interface MockState {
  readonly pushes: { userId: string; text: string }[];
  failNextPush: boolean;
}

/** mock 依赖。 */
export interface MockAdapterOptions {
  readonly accountKey?: string
  readonly token?: string
  readonly nowMs?: () => number
}

/** mock 适配器（带一个只读状态出口，供测试断言"发了什么"）。 */
export interface MockAdapter extends PlatformAdapter {
  readonly state: MockState
}

/**
 * 造一个 mock 适配器。
 *
 * `parse` 的请求体是 JSON：`{ userId, text, messageId? }`；
 * `{ kind: 'event' }` 走"不支持"分支（与微信的事件消息同形）。
 */
export function createMockAdapter(options: MockAdapterOptions = {}): MockAdapter {
  const token = options.token ?? 'mock-token'
  const nowMs = options.nowMs ?? ((): number => Date.now())
  const state: MockState = { pushes: [], failNextPush: false }

  const json = (status: number, body: unknown): PlatformResponse => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  })

  return {
    id: 'mock',
    capabilities: MOCK_CAPABILITIES,
    state,

    verify(request: PlatformRequest): PlatformVerdict {
      return request.query['token'] === token
        ? { ok: true }
        : { ok: false, status: 401, code: 'im-sig-mismatch' }
    },

    parse(request: PlatformRequest): PlatformParseResult {
      if (request.method === 'GET') {
        const echo = request.query['echostr'] ?? ''
        if (echo.length === 0) return { kind: 'reject', status: 400, code: 'im-challenge-missing' }
        return { kind: 'challenge', response: { status: 200, headers: { 'content-type': 'text/plain' }, body: echo } }
      }

      let body: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(request.body)
        if (typeof parsed !== 'object' || parsed === null) {
          return { kind: 'reject', status: 400, code: 'im-json-invalid' }
        }
        body = parsed as Record<string, unknown>
      } catch {
        return { kind: 'reject', status: 400, code: 'im-json-invalid' }
      }

      if (body['kind'] === 'event') {
        return {
          kind: 'unsupported',
          response: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'success' },
        }
      }

      const userId = typeof body['userId'] === 'string' ? body['userId'] : ''
      const text = typeof body['text'] === 'string' ? body['text'] : ''
      if (userId.length === 0 || text.length === 0) {
        return { kind: 'reject', status: 400, code: 'im-json-invalid' }
      }
      const messageId = typeof body['messageId'] === 'string' ? body['messageId'] : undefined

      const inbound: ImInbound = {
        platform: 'mock',
        accountKey: options.accountKey ?? 'default',
        userId,
        text,
        ...(messageId === undefined ? {} : { messageId }),
        at: nowMs(),
      }

      return {
        kind: 'message',
        inbound,
        reply: {
          passive(outbounds: readonly ImOutbound[]): PlatformResponse {
            return json(200, { outbounds: outbounds.map(outboundText) })
          },
          async push(outbounds: readonly ImOutbound[]): Promise<PlatformPushResult> {
            if (state.failNextPush) {
              state.failNextPush = false
              return { ok: false, code: 'unavailable', reason: 'mock-failure' }
            }
            for (const outbound of outbounds) {
              state.pushes.push({ userId, text: outboundText(outbound) })
            }
            return { ok: true }
          },
        },
      }
    },
  }
}
