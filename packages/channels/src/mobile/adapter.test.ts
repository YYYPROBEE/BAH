/**
 * 移动渠道薄工厂的用例（施工单 01 §5 TC-MCH-06）。
 *
 * 只测"它是 mobile 且能力位是同一引用"：审批语义由 `http-adapter.test.ts` 覆盖，
 * 在这里重复一遍只会制造两份会漂的断言。
 */

import { describe, expect, it } from 'vitest'

import { MOBILE_CAPABILITIES } from '../capabilities.ts'
import { MOBILE_CHANNEL_ID, createMobileChannelAdapter } from './adapter.ts'

describe('createMobileChannelAdapter（TC-MCH-06）', () => {
  it('id 是 mobile', () => {
    expect(MOBILE_CHANNEL_ID).toBe('mobile')
    expect(createMobileChannelAdapter().id).toBe('mobile')
  })

  it('capabilities 与 MOBILE_CAPABILITIES 是同一引用（不是深拷贝）', () => {
    expect(createMobileChannelAdapter().capabilities).toBe(MOBILE_CAPABILITIES)
  })

  it('sessionId 原样透传：归属校验在移动端同样生效（W04）', () => {
    const adapter = createMobileChannelAdapter({ sessionId: 's-mobile' })
    const controller = new AbortController()
    adapter.attachApproval({
      ticketId: 'ticket:x',
      sessionId: 's-other',
      callId: 'call-x',
      name: 'transfer_create',
      signal: controller.signal,
      answer: () => ({ accepted: true }),
    })
    expect(adapter.decide('ticket:x', { decision: 'allowed-once' })).toMatchObject({
      ok: false,
      code: 'foreign-ticket',
    })
  })
})
