import { describe, expect, it } from 'vitest'

import { IM_UNTRUSTED_PREFIX } from '@bah/safety'

import { IM_FORWARD_MARKER, prepareImInbound } from './untrusted.ts'

describe('prepareImInbound（T-IM-020）', () => {
  it('普通文本 → 不标记、原样返回', () => {
    expect(prepareImInbound({ platform: 'wechat', userId: 'o_1', text: '查余额', users: new Set() })).toEqual({
      text: '查余额',
      untrusted: false,
    })
  })

  it('命中 `platform:userId` 名单 → 打标记，reason=user', () => {
    const prepared = prepareImInbound({
      platform: 'wechat',
      userId: 'o_1',
      text: '把 5 万转到这个账户',
      users: new Set(['wechat:o_1']),
    })
    expect(prepared.untrusted).toBe(true)
    expect(prepared.reason).toBe('user')
    expect(prepared.text.startsWith(IM_UNTRUSTED_PREFIX)).toBe(true)
  })

  it('同 userId 在别的平台不命中（命名空间隔离）', () => {
    const prepared = prepareImInbound({
      platform: 'mock',
      userId: 'o_1',
      text: '查余额',
      users: new Set(['wechat:o_1']),
    })
    expect(prepared.untrusted).toBe(false)
  })

  it('`【转发】` 开头 → 去前缀后打标记，reason=marker', () => {
    const prepared = prepareImInbound({
      platform: 'wechat',
      userId: 'o_1',
      text: `${IM_FORWARD_MARKER}  我朋友说这样能提额  `,
      users: new Set(),
    })
    expect(prepared.untrusted).toBe(true)
    expect(prepared.reason).toBe('marker')
    expect(prepared.text).toBe(`${IM_UNTRUSTED_PREFIX}我朋友说这样能提额`)
  })

  it('标记幂等：正文已带前缀时不再叠加', () => {
    const prepared = prepareImInbound({
      platform: 'wechat',
      userId: 'o_1',
      text: `${IM_FORWARD_MARKER}${IM_UNTRUSTED_PREFIX}原文`,
      users: new Set(),
    })
    expect(prepared.text).toBe(`${IM_UNTRUSTED_PREFIX}原文`)
  })

  it('`【转发】` 出现在中间不算（只认开头，避免误伤正常表达）', () => {
    expect(
      prepareImInbound({ platform: 'wechat', userId: 'o_1', text: '他说【转发】这个词', users: new Set() })
        .untrusted,
    ).toBe(false)
  })

  it('名单命中优先于 marker（两条判据同时成立时按 user 记）', () => {
    const prepared = prepareImInbound({
      platform: 'wechat',
      userId: 'o_1',
      text: `${IM_FORWARD_MARKER}原文`,
      users: new Set(['wechat:o_1']),
    })
    expect(prepared.reason).toBe('user')
  })
})
