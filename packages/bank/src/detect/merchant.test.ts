/**
 * 商户归一化（场景 5 §6.1 / §6.8 case 11）。
 *
 * 断言三件事：前缀/后缀/全角能剥；别名能归；**幂等**。
 */

import { describe, expect, it } from 'vitest'

import { normalizeMerchant } from './merchant.ts'

describe('normalizeMerchant 渠道前缀', () => {
  it('STM* 前缀（案例 11 的原始名）', () => {
    expect(normalizeMerchant('STM*VIDEO')).toBe('视频会员')
  })

  it('STM 无星号前缀', () => {
    expect(normalizeMerchant('STM SPOTIFY')).toBe('spotify')
  })

  it('支付宝- 前缀', () => {
    expect(normalizeMerchant('支付宝-云音乐')).toBe('云音乐')
  })

  it('财付通- 前缀与门店括号', () => {
    expect(normalizeMerchant('财付通-某某健身(朝阳店)')).toBe('某某健身')
  })

  it('微信支付- / 快捷支付- / 银联- 前缀', () => {
    expect(normalizeMerchant('微信支付-新闻会员')).toBe('新闻会员')
    expect(normalizeMerchant('快捷支付-阅读包月')).toBe('阅读包月')
    expect(normalizeMerchant('银联-网盘超级会员')).toBe('网盘超级会员')
  })

  it('双层前缀（支付宝-特约-…）一次剥干净', () => {
    expect(normalizeMerchant('支付宝-特约-视频会员')).toBe('视频会员')
  })
})

describe('normalizeMerchant 噪声后缀', () => {
  it('门店号 #123', () => {
    expect(normalizeMerchant('云音乐#123')).toBe('云音乐')
  })

  it('尾号 *8888', () => {
    expect(normalizeMerchant('云音乐*8888')).toBe('云音乐')
  })

  it('连续数字', () => {
    expect(normalizeMerchant('阅读包月 2026')).toBe('阅读包月')
  })

  it('全角转半角 + 小写化', () => {
    expect(normalizeMerchant('ＳＴＭ＊ＶＩＤＥＯ')).toBe('视频会员')
  })

  it('空白与标点', () => {
    expect(normalizeMerchant('  房租 - 王房东  ')).toBe('房租王房东')
  })

  it('前缀两侧有空格也能剥离（支付宝 - 云音乐）', () => {
    expect(normalizeMerchant('支付宝 - 云音乐')).toBe('云音乐')
  })
})

describe('normalizeMerchant 别名与稳定性', () => {
  it('别名表：网易云音乐 → 云音乐', () => {
    expect(normalizeMerchant('网易云音乐')).toBe('云音乐')
    expect(normalizeMerchant('云音乐会员')).toBe('云音乐')
  })

  it('未知名字原样保留（不做隐式猜测）', () => {
    expect(normalizeMerchant('XX软件订阅')).toBe('xx软件订阅')
  })

  it('幂等：normalize(normalize(x)) === normalize(x)', () => {
    for (const raw of [
      'STM*VIDEO',
      '支付宝-云音乐',
      '财付通-某某健身(朝阳店)',
      'ＳＴＭ＊ＶＩＤＥＯ',
      '云音乐#123',
      '房租-王房东',
      '***',
      '',
    ]) {
      const once = normalizeMerchant(raw)
      expect(normalizeMerchant(once)).toBe(once)
    }
  })

  it('纯噪声不并成一个空键（保持可区分）', () => {
    expect(normalizeMerchant('***')).toBe('***')
    expect(normalizeMerchant('!!!')).toBe('!!!')
  })
})
