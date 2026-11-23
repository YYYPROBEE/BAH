/**
 * 窗口回执：确定性、绑定性、密钥纪律。
 *
 * 这些断言服务两个目的：
 * 1. 快照 / 集成用例能复现（同一 payload + 同一密钥必须逐字节相同）；
 * 2. 回执不能被"改一个字段再用"（窗口 / 节点 / 时间任一变化都必须验不过）。
 */

import { describe, expect, it } from 'vitest'

import {
  WINDOW_RECEIPT_KEY_MIN_BYTES,
  createWindowReceipt,
  resolveWindowReceiptKey,
  verifyWindowReceipt,
  type WindowReceiptPayload,
} from './window-receipt.ts'

const KEY = 'bah-window-receipt-test-key-0123456789abcdef'

const PAYLOAD: WindowReceiptPayload = {
  sessionId: 's-1',
  windowId: 'w-call-1',
  planId: 'plan-call-1',
  nodeIds: ['pay'],
  challengeId: 'vc-1',
  channel: 'sms',
  verifiedAt: 1_000,
  expiresAt: 61_000,
}

describe('window-receipt', () => {
  it('同一 payload + 同一密钥 ⇒ 同一回执，且验签通过', () => {
    const first = createWindowReceipt(KEY, PAYLOAD)
    const second = createWindowReceipt(KEY, { ...PAYLOAD })
    expect(second).toBe(first)
    expect(verifyWindowReceipt(KEY, PAYLOAD, first)).toBe(true)
  })

  it('键序不影响结果（canonicalJson 归一）', () => {
    const reordered: WindowReceiptPayload = {
      expiresAt: PAYLOAD.expiresAt,
      verifiedAt: PAYLOAD.verifiedAt,
      channel: PAYLOAD.channel,
      challengeId: PAYLOAD.challengeId,
      nodeIds: PAYLOAD.nodeIds,
      planId: PAYLOAD.planId,
      windowId: PAYLOAD.windowId,
      sessionId: PAYLOAD.sessionId,
    }
    expect(createWindowReceipt(KEY, reordered)).toBe(createWindowReceipt(KEY, PAYLOAD))
  })

  it('任一绑定字段被改 ⇒ 验不过（窗口 / 节点 / 时间 / 渠道）', () => {
    const receipt = createWindowReceipt(KEY, PAYLOAD)
    const tampered: readonly Partial<WindowReceiptPayload>[] = [
      { windowId: 'w-call-2' },
      { planId: 'plan-call-2' },
      { nodeIds: ['pay', 'extra'] },
      { challengeId: 'vc-2' },
      { channel: 'face' },
      { verifiedAt: PAYLOAD.verifiedAt + 1 },
      { expiresAt: PAYLOAD.expiresAt + 1 },
      { sessionId: 's-2' },
    ]
    for (const change of tampered) {
      expect(verifyWindowReceipt(KEY, { ...PAYLOAD, ...change }, receipt)).toBe(false)
    }
  })

  it('换密钥 ⇒ 验不过；空回执 ⇒ 验不过（异常不翻译成放行）', () => {
    const receipt = createWindowReceipt(KEY, PAYLOAD)
    expect(verifyWindowReceipt('another-window-receipt-key-0123456789', PAYLOAD, receipt)).toBe(false)
    expect(verifyWindowReceipt(KEY, PAYLOAD, '')).toBe(false)
    expect(verifyWindowReceipt(KEY, PAYLOAD, 'not-base64-!!')).toBe(false)
  })

  it('密钥解析：空 / 过短一律视为未配置', () => {
    expect(resolveWindowReceiptKey(undefined)).toBeUndefined()
    expect(resolveWindowReceiptKey('   ')).toBeUndefined()
    expect(resolveWindowReceiptKey('a'.repeat(WINDOW_RECEIPT_KEY_MIN_BYTES - 1))).toBeUndefined()
    expect(resolveWindowReceiptKey(` ${KEY} `)).toBe(KEY)
  })
})
