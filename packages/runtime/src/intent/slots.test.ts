import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import {
  EMPTY_SLOT_TABLE,
  type FilledSlot,
  type SlotTable,
} from './types.ts'
import {
  accountTail,
  addDays,
  centsToYuan,
  detectConflicts,
  extractAmountCents,
  extractPayee,
  extractTimeRange,
  findMissing,
  maskName,
  maskPhone,
  mergeByPriority,
  normalizeUtteranceSlots,
  yuanToCents,
} from './slots.ts'

const TODAY = '2026-10-28'

const slot = (name: FilledSlot['name'], value: string | number, source: FilledSlot['source']): FilledSlot => ({
  name,
  value,
  source,
  confidence: 0.9,
})

function expectBahError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(BahError)
    expect((error as BahError).code).toBe(code)
    return
  }
  throw new Error('期望抛错但没有')
}

describe('金额归一化（TC-INT-16～18）', () => {
  it('元 → 分：小数一位、整数、最小分', () => {
    expect(yuanToCents('500.5')).toBe(50050)
    expect(yuanToCents('500')).toBe(50000)
    expect(yuanToCents('0.01')).toBe(1)
  })

  it('非法金额 fail-loud，报错不回显原文', () => {
    for (const bad of ['500.555', '-1', 'abc', '1e3']) {
      try {
        yuanToCents(bad)
        throw new Error('期望抛错')
      } catch (error) {
        expect((error as BahError).code).toBe('intent-amount-invalid')
        expect((error as BahError).message).not.toContain(bad)
      }
    }
  })

  it('空串也走 fail-loud 分支', () => {
    expectBahError(() => yuanToCents(''), 'intent-amount-invalid')
  })

  it('分 → 元 roundtrip', () => {
    for (const cents of [0, 1, 99, 100, 50050, 123456]) {
      expect(yuanToCents(centsToYuan(cents))).toBe(cents)
    }
    expect(centsToYuan(50050)).toBe('500.50')
  })

  it('分 → 元拒绝负数与非整数', () => {
    expectBahError(() => centsToYuan(-1), 'intent-amount-invalid')
    expectBahError(() => centsToYuan(1.5), 'intent-amount-invalid')
  })
})

describe('PII 脱敏（TC-INT-19/20）', () => {
  it('手机号保留前 3 后 4', () => {
    expect(maskPhone('13812345678')).toBe('138****5678')
    expectBahError(() => maskPhone('123'), 'intent-pii-invalid')
  })

  it('姓名单姓与复姓', () => {
    expect(maskName('张伟')).toBe('张**')
    expect(maskName('欧阳娜娜')).toBe('欧阳**')
    expectBahError(() => maskName(''), 'intent-pii-invalid')
  })

  it('账号只出尾号', () => {
    expect(accountTail('6222021234561234')).toBe('****1234')
    expectBahError(() => accountTail('123'), 'intent-pii-invalid')
  })
})

describe('原话抽取', () => {
  it('金额优先带单位', () => {
    expect(extractAmountCents('给张三转 500.5 元')).toEqual({ cents: 50050, span: '500.5 元' })
    expect(extractAmountCents('转800')).toEqual({ cents: 80000, span: '800' })
  })

  it('长数字不当金额（卡号/尾号）', () => {
    expect(extractAmountCents('卡号6222021234561234')).toBeUndefined()
    expect(extractAmountCents('随便')).toBeUndefined()
  })

  it('日期/时刻里的数字不当金额（D-1）', () => {
    // 「每月 1 号转 3500」曾经取到第一个数字 1（¥1.00）
    expect(extractAmountCents('每月 1 号给我妈转 3500')).toEqual({ cents: 350000, span: '3500' })
    expect(extractAmountCents('每个月1号转3500')).toEqual({ cents: 350000, span: '3500' })
    expect(extractAmountCents('1 号还 500')).toEqual({ cents: 50000, span: '500' })
    expect(extractAmountCents('2023年11月19日转500')).toEqual({ cents: 50000, span: '500' })
    expect(extractAmountCents('2023-11-19 转 500')).toEqual({ cents: 50000, span: '500' })
    expect(extractAmountCents('3 天后转 200')).toEqual({ cents: 20000, span: '200' })
    expect(extractAmountCents('第 1 期还 800')).toEqual({ cents: 80000, span: '800' })
  })

  it('带单位时仍以单位为准（日期数字不干扰）', () => {
    expect(extractAmountCents('每月 1 号转 3500 元')).toEqual({ cents: 350000, span: '3500 元' })
    expect(extractAmountCents('1 号转 800 块')).toEqual({ cents: 80000, span: '800 块' })
  })

  it('收款人三种说法', () => {
    expect(extractPayee('给张三转500')).toBe('张三')
    expect(extractPayee('转给李四')).toBe('李四')
    expect(extractPayee('收款人：王五')).toBe('王五')
  })

  it('11 位手机号可作为收款人（「按手机号转账」）', () => {
    expect(extractPayee('给 13800005678 转 2000')).toBe('13800005678')
    expect(extractPayee('转给13800005678 200 元')).toBe('13800005678')
    expect(extractPayee('收款人：13800005678')).toBe('13800005678')
  })

  it('代词与纯数字不入收款人槽位', () => {
    expect(extractPayee('转给他')).toBeUndefined()
    expect(extractPayee('转给123')).toBeUndefined()
    expect(extractPayee('转500')).toBeUndefined()
  })

  it('相对时间归一化为注入日期上的区间', () => {
    expect(extractTimeRange('看今天的', TODAY)).toBe('2026-10-28..2026-10-28')
    expect(extractTimeRange('看昨天的', TODAY)).toBe('2026-10-27..2026-10-28')
    expect(extractTimeRange('最近消费', TODAY)).toBe('2026-10-21..2026-10-28')
    expect(extractTimeRange('上个月的', TODAY)).toBe('2026-09-28..2026-10-28')
    expect(extractTimeRange('转账', TODAY)).toBeUndefined()
  })

  it('日期运算跨月且 fail-loud', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expectBahError(() => addDays('2026/10/28', -1), 'intent-date-invalid')
  })

  it('一次抽齐四类槽位', () => {
    const result = normalizeUtteranceSlots('给张三转500元，尾号1234，今天', TODAY, 'transfer')
    const names = result.slots.map((item) => item.name)
    expect(names).toEqual(['amountCents', 'payee', 'account', 'timeRange'])
    expect(result.slots.find((item) => item.name === 'amountCents')?.value).toBe(50000)
    expect(result.slots.find((item) => item.name === 'account')?.value).toBe('****1234')
    expect(result.amountSpan).toBe('500元')
    expect(result.payeeSpan).toBe('张三')
  })

  it('空槽位时不带可选字段', () => {
    const result = normalizeUtteranceSlots('随便', TODAY, 'unknown')
    expect(result.slots).toEqual([])
    expect('amountSpan' in result).toBe(false)
    expect('payeeSpan' in result).toBe(false)
  })
})

describe('两层合并与冲突（TC-INT-15）', () => {
  it('turn 层覆盖 session 层', () => {
    const table: SlotTable = {
      session: { amountCents: slot('amountCents', 50000, 'session') },
      turn: { amountCents: slot('amountCents', 80000, 'user-choice') },
      askCount: {},
    }
    const merged = mergeByPriority(table, [])
    expect(merged).toEqual([slot('amountCents', 80000, 'user-choice')])
  })

  it('utterance 覆盖 session（改口不是冲突）', () => {
    const table: SlotTable = {
      session: { amountCents: slot('amountCents', 50000, 'session') },
      turn: {},
      askCount: {},
    }
    const merged = mergeByPriority(table, [slot('amountCents', 80000, 'utterance')])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.value).toBe(80000)
  })

  it('同优先级多值保留为候选；同值去重', () => {
    const merged = mergeByPriority(EMPTY_SLOT_TABLE, [], [
      slot('payee', '张伟（同事）', 'memory'),
      slot('payee', '张伟（房东）', 'memory'),
      slot('payee', '张伟（房东）', 'memory'),
    ])
    expect(merged.map((item) => item.value)).toEqual(['张伟（同事）', '张伟（房东）'])
  })

  it('session 层 undefined 槽位被跳过', () => {
    const table: SlotTable = { session: { payee: undefined }, turn: {}, askCount: {} }
    expect(mergeByPriority(table, [])).toEqual([])
  })

  it('冲突检测按槽位名排序', () => {
    const conflicts = detectConflicts([
      slot('payee', 'a', 'memory'),
      slot('payee', 'b', 'memory'),
      slot('amountCents', 1, 'memory'),
      slot('amountCents', 2, 'memory'),
    ])
    expect(conflicts.map((item) => item.name)).toEqual(['amountCents', 'payee'])
  })

  it('单值不构成冲突', () => {
    expect(detectConflicts([slot('payee', 'a', 'memory')])).toEqual([])
  })
})

describe('缺失判定', () => {
  it('implicit / ambiguous 不判缺失', () => {
    expect(findMissing('implicit', 'transfer', [], [])).toEqual([])
    expect(findMissing('ambiguous', 'transfer', [], [])).toEqual([])
  })

  it('按场景必填表判缺', () => {
    expect(findMissing('explicit', 'transfer', [slot('payee', '张三', 'utterance')], [])).toEqual([
      'amountCents',
    ])
    expect(findMissing('explicit', 'investment', [], [])).toEqual(['product'])
    expect(findMissing('explicit', 'unknown', [], [])).toEqual([])
  })

  it('冲突槽位不算缺失（它进 conflicts）', () => {
    expect(
      findMissing('explicit', 'transfer', [], [{ name: 'payee', candidates: [slot('payee', 'a', 'memory')] }]),
    ).toEqual(['amountCents'])
  })
})
