/**
 * 结构化错误断言助手自测。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { captureRejection, captureThrown } from './index.ts'

describe('captureThrown', () => {
  it('抓到 BahError 并保留 code / detail', () => {
    const error = captureThrown(() => {
      throw new BahError('ticket-expired', 'bah-bank: 票据过期', { ticketId: 't-1' })
    })

    expect(error.code).toBe('ticket-expired')
    expect(error.detail).toEqual({ ticketId: 't-1' })
  })

  it('没抛时以可读理由失败', () => {
    expect(() => captureThrown(() => undefined)).toThrow(/期望抛出 BahError，但没有抛/)
  })

  it('抛的不是 BahError 时带上实际类型', () => {
    expect(() =>
      captureThrown(() => {
        throw new TypeError('boom')
      }),
    ).toThrow(/实际抛出 TypeError: boom/)

    expect(() =>
      captureThrown(() => {
        throw 'raw-failure'
      }),
    ).toThrow(/实际抛出 raw-failure/)
  })
})

describe('captureRejection', () => {
  it('抓到 reject 的 BahError', async () => {
    const error = await captureRejection(async () => {
      throw new BahError('no-identity', 'bah-bank: 无身份')
    })

    expect(error.code).toBe('no-identity')
  })

  it('没 reject 时以可读理由失败', async () => {
    await expect(captureRejection(async () => undefined)).rejects.toThrow(
      /期望 reject BahError，但没有 reject/,
    )
  })

  it('reject 的不是 BahError 时带上实际错误', async () => {
    await expect(
      captureRejection(async () => {
        throw new Error('upstream-down')
      }),
    ).rejects.toThrow(/实际 reject Error: upstream-down/)
  })
})
