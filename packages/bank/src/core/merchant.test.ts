/**
 * 商户品类词典（账单场景收口 01 · T-01）。
 *
 * 断言口径：demo 8 家逐一钉死；未知/空名走兜底；顺序用例证明"长的先匹配"；
 * 标签表按 `MerchantCategory` 穷尽，漏一个编译期就红。
 */

import { describe, expect, it } from 'vitest'

import { MERCHANT_LABEL, merchantCategoryOf, type MerchantCategory } from './merchant.ts'

describe('merchantCategoryOf', () => {
  it('demo 8 家逐一命中（含工资与个人转账的兜底）', () => {
    expect(merchantCategoryOf('盒马鲜生')).toBe('grocery')
    expect(merchantCategoryOf('地铁出行')).toBe('transit')
    expect(merchantCategoryOf('国美电器')).toBe('shopping')
    expect(merchantCategoryOf('海底捞')).toBe('dining')
    expect(merchantCategoryOf('瑞幸咖啡')).toBe('coffee')
    expect(merchantCategoryOf('视频会员')).toBe('digital')
    expect(merchantCategoryOf('工资代发')).toBe('salary')
    // 人名不进词典：转账/工资由调用方用账务分类覆盖，词典本身绝不猜
    expect(merchantCategoryOf('王建国')).toBe('other')
  })

  it('关键词层：外卖 / 滴滴 / 云音乐 / 超市 / 话费', () => {
    expect(merchantCategoryOf('饿了么外卖')).toBe('dining')
    expect(merchantCategoryOf('滴滴出行')).toBe('transit')
    expect(merchantCategoryOf('网易云音乐')).toBe('digital')
    expect(merchantCategoryOf('永辉超市')).toBe('grocery')
    expect(merchantCategoryOf('中国联通')).toBe('digital')
  })

  it('顺序：瑞幸咖啡命中 coffee，而不是被通用词吃掉', () => {
    expect(merchantCategoryOf('瑞幸咖啡')).toBe('coffee')
    expect(merchantCategoryOf('MANNER咖啡')).toBe('coffee')
  })

  it('大小写与空白：归一后仍命中', () => {
    expect(merchantCategoryOf('  MANNER咖啡  ')).toBe('coffee')
    expect(merchantCategoryOf('MannerCoffee')).toBe('other')
  })

  it('未知商户与空名走 other（不猜、不调模型）', () => {
    expect(merchantCategoryOf('未知商户')).toBe('other')
    expect(merchantCategoryOf('')).toBe('other')
    expect(merchantCategoryOf('   ')).toBe('other')
  })
})

describe('MERCHANT_LABEL', () => {
  it('9 个品类全部有文案（穷尽表）', () => {
    const categories: readonly MerchantCategory[] = [
      'dining',
      'coffee',
      'grocery',
      'transit',
      'shopping',
      'digital',
      'transfer',
      'salary',
      'other',
    ]
    expect(Object.keys(MERCHANT_LABEL)).toHaveLength(categories.length)
    for (const category of categories) {
      expect(MERCHANT_LABEL[category].trim().length).toBeGreaterThan(0)
    }
  })
})
