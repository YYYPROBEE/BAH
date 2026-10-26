/**
 * W09 · 可替换的强验证 Provider（测试网关适配器）。
 *
 * 三条不变量：
 * 1. 接口与 `createMockVerifyProvider` 完全一致：`VerifyService` 不需要知道实现；
 * 2. 默认客户端是确定性测试网关，不接任何真实供应商；
 * 3. 失败计数与锁定**不在本层**——网关只回答一次验证成功/失败。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import {
  createGatewayVerifyProvider,
  createTestGatewayClient,
  type VerifyGatewayClient,
} from './verify-gateway.ts'

describe('W09 强验证网关 Provider', () => {
  it('默认：第 1 次尝试成功（与 mock 缺省行为一致）', async () => {
    const provider = createGatewayVerifyProvider()
    expect(await provider.verify({ challengeId: 'vc-1', channel: 'sms', attempt: 1 })).toEqual({
      success: true,
    })
  })

  it('successAfter：第 N 次起成功', async () => {
    const provider = createGatewayVerifyProvider({ successAfter: 3 })
    expect(await provider.verify({ challengeId: 'vc-1', channel: 'face', attempt: 1 })).toEqual({
      success: false,
    })
    expect(await provider.verify({ challengeId: 'vc-1', channel: 'face', attempt: 2 })).toEqual({
      success: false,
    })
    expect(await provider.verify({ challengeId: 'vc-1', channel: 'face', attempt: 3 })).toEqual({
      success: true,
    })
  })

  it('可注入自定义客户端：真实供应商只需实现 VerifyGatewayClient', async () => {
    const seen: string[] = []
    const client: VerifyGatewayClient = {
      id: 'vendor-x',
      verify: async (attempt) => {
        seen.push(`${attempt.channel}:${String(attempt.attempt)}`)
        return { success: attempt.channel === 'ushield' }
      },
    }
    const provider = createGatewayVerifyProvider({ client })
    expect(await provider.verify({ challengeId: 'vc-1', channel: 'sms', attempt: 1 })).toEqual({
      success: false,
    })
    expect(await provider.verify({ challengeId: 'vc-1', channel: 'ushield', attempt: 1 })).toEqual({
      success: true,
    })
    expect(seen).toEqual(['sms:1', 'ushield:1'])
  })

  it('未开通的渠道一律失败（不泄露渠道是否存在）', async () => {
    const client = createTestGatewayClient({ acceptedChannels: ['sms'] })
    expect(await client.verify({ challengeId: 'vc-1', channel: 'face', attempt: 1 })).toEqual({
      success: false,
    })
    expect(await client.verify({ challengeId: 'vc-1', channel: 'sms', attempt: 1 })).toEqual({
      success: true,
    })
  })

  it('非法 successAfter / 非法尝试序号 → 结构化错误（不静默放行）', () => {
    expect(
      captureThrown(() => createGatewayVerifyProvider({ successAfter: 0 })).code,
    ).toBe('verify-gateway-invalid')
    expect(
      captureThrown(() => createTestGatewayClient({ successAfter: 1.5 })).code,
    ).toBe('verify-gateway-invalid')
    const provider = createGatewayVerifyProvider()
    return expect(
      provider.verify({ challengeId: 'vc-1', channel: 'sms', attempt: 0 }),
    ).rejects.toMatchObject({ code: 'verify-gateway-invalid' })
  })
})
