/**
 * 账单报告卡的结构化块：从 `read/bill-report` 事件派生，挂到 `bill_report` 卡片上。
 *
 * 这一组守四件事：
 * 1. **只认事件**：分类表与金额来自落账的 `analysis`，不从报告正文反解；
 * 2. **人话口径**：分类是中文（`转账` 不是 `transfer`）、金额是元（`¥3,003.70` 不是 `300370 分`）；
 * 3. **不猜**：载荷形状不对就整块不产，卡片退回正文排版——半张表比没有表更误导；
 * 4. **不重复**：有了字段与表格，同一段报告文本不再出现在卡片里。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { billReportBlockOf, PAYEE_LIMIT } from './bill-report.ts'
import { buildCard } from './cards.ts'
import { WebProjector } from './project.ts'

import type { CardView } from './frames.ts'

const T0 = 1_700_000_000_000

/** 造一个 `read/bill-report` 载荷（与 `@bah/bank` 的 `BillReportResult` 同形）。 */
function reportEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const analysis: Record<string, unknown> = {
    period: 'quarter',
    months: ['2026-09', '2026-10'],
    totalInCents: 1_000_000,
    totalOutCents: 765_432,
    momChangePct: 12.34,
    byCategory: [
      { category: 'transfer', amountCents: 380_370, sharePct: 49.69 },
      { category: 'consumption', amountCents: 300_370, sharePct: 39.24 },
    ],
    byPayee: [
      { payee: '京东', amountCents: 120_000, sharePct: 15.68 },
      { payee: '美团', amountCents: 80_000, sharePct: 10.45 },
    ],
    anomalies: [{ kind: 'large', txnId: 'txn-1', note: '大额支出 ¥3,003.70' }],
    ...overrides,
  }
  return {
    result: {
      period: 'quarter',
      format: 'detail',
      text: '账单报告（2026-09 / 2026-10，季度）\n分类汇总：\n- transfer: ¥3,803.70（49.69%）',
      analysis,
    },
  }
}

describe('billReportBlockOf', () => {
  it('分类表用中文与元；字段含账期 / 收支 / 环比 / 异常', () => {
    const block = billReportBlockOf(reportEvent())
    const fieldOf = (label: string): string | undefined =>
      block?.fields.find((field) => field.label === label)?.value

    expect(fieldOf('账期')).toBe('2026-09 ~ 2026-10（季度）')
    expect(fieldOf('收入')).toBe('¥10,000.00')
    expect(fieldOf('支出')).toBe('¥7,654.32')
    expect(fieldOf('环比')).toBe('12.34%')
    expect(fieldOf('异常')).toBe('1 条')
    expect(block?.table?.headers).toEqual(['分类', '金额', '占比'])
    expect(block?.table?.rows).toEqual([
      ['转账', '¥3,803.70', '49.69%'],
      ['消费', '¥3,003.70', '39.24%'],
    ])
    expect(block?.note).toBe('收款人前 2：京东 ¥1,200.00（15.68%）、美团 ¥800.00（10.45%）\n异常：大额支出 ¥3,003.70')
  })

  it('两次回放逐字相同（帧是纯数据，不读时钟）', () => {
    expect(billReportBlockOf(reportEvent())).toStrictEqual(billReportBlockOf(reportEvent()))
  })

  it('口径与账期缺失：不编月份也不编口径', () => {
    const block = billReportBlockOf(reportEvent({ months: [], period: 'week' }))
    expect(block?.fields[0]).toEqual({ label: '账期', value: '账期未知' })

    // 单账期不写区间（`2026-10 ~ 2026-10` 是噪声）
    const single = billReportBlockOf(reportEvent({ months: ['2026-10'], period: 'month' }))
    expect(single?.fields[0]?.value).toBe('2026-10（月度）')
  })

  it('年度口径带"覆盖 N/12 个账期"', () => {
    const block = billReportBlockOf(
      reportEvent({ period: 'year', months: ['2025-11', '2026-10'], coveredMonths: 11, momChangePct: undefined }),
    )
    expect(block?.fields[0]?.value).toBe('2025-11 ~ 2026-10（年度） · 覆盖 11/12 个账期')
    // 没有环比基线就不显示环比（宁可少一行，不写"无上期数据"占位）
    expect(block?.fields.some((field) => field.label === '环比')).toBe(false)
  })

  it('收支总额拿不到 ⇒ 整块不产（卡片退回正文，不拼一张缺总数的表）', () => {
    expect(billReportBlockOf(undefined)).toBeUndefined()
    expect(billReportBlockOf({})).toBeUndefined()
    expect(billReportBlockOf({ result: {} })).toBeUndefined()
    expect(billReportBlockOf({ result: { analysis: { totalInCents: 1 } } })).toBeUndefined()
  })

  it('分类行形态不对就跳过；一行都不剩就不产表', () => {
    const partial = billReportBlockOf(
      reportEvent({ byCategory: [{ category: 'fee' }, { category: 'refund', amountCents: 5_000, sharePct: 3.1 }] }),
    )
    expect(partial?.table?.rows).toEqual([['退款', '¥50.00', '3.1%']])

    const none = billReportBlockOf(
      reportEvent({ byCategory: [{ category: 'fee' }], byPayee: [], anomalies: [] }),
    )
    expect(none?.table).toBeUndefined()
    expect(none?.note).toBeUndefined()
    expect(none?.fields.find((field) => field.label === '异常')?.value).toBe('0 条')
  })

  it('没登记的分类保留原值（不翻译成别的分类，也不丢行）', () => {
    const block = billReportBlockOf(
      reportEvent({ byCategory: [{ category: 'foreign', amountCents: 1_00, sharePct: 1 }] }),
    )
    expect(block?.table?.rows).toEqual([['foreign', '¥1.00', '1%']])
  })

  it('收款人超过上限只列前 5，并如实报总数', () => {
    const block = billReportBlockOf(
      reportEvent({
        byPayee: Array.from({ length: 7 }, (_unused, index) => ({
          payee: `商户${String(index + 1)}`,
          amountCents: 1_000 * (index + 1),
          sharePct: index + 1,
        })),
      }),
    )
    expect(block?.note?.split('\n')[0]).toContain(`收款人前 ${String(PAYEE_LIMIT)}：商户1 ¥10.00（1%）`)
    expect(block?.note?.split('\n')[0]).toContain('共 7 项，下列前 5 项')
  })

  it('异常超过说明上限：计数仍是总条数', () => {
    const block = billReportBlockOf(
      reportEvent({
        anomalies: Array.from({ length: 5 }, (_unused, index) => ({
          kind: 'large',
          txnId: `txn-${String(index)}`,
          note: `大额支出 ¥${String(index + 1)}.00`,
        })),
      }),
    )
    expect(block?.fields.find((field) => field.label === '异常')?.value).toBe('5 条')
    expect(block?.note?.split('\n').at(-1)).toBe('异常：大额支出 ¥1.00、大额支出 ¥2.00、大额支出 ¥3.00')
  })
})

describe('bill_report 卡片', () => {
  it('字段 + 表格 + 说明进卡，报告正文不再重复出现', () => {
    const block = billReportBlockOf(reportEvent())!
    const card = buildCard({
      name: 'bill_report',
      args: { period: 'quarter', format: 'detail' },
      content: [{ type: 'text', text: '账单报告（2026-09 / 2026-10，季度）\n分类汇总：\n- transfer: ¥3,803.70' }],
      isError: false,
      amountConfirmed: true,
      billReport: block,
    })

    expect(card.title).toBe('账单报告')
    expect(card.template).toBe('ledger')
    expect(card.fields.map((field) => field.label)).toEqual(['账期', '收入', '支出', '环比', '异常'])
    expect(card.table?.rows[0]).toEqual(['转账', '¥3,803.70', '49.69%'])
    expect(card.note).toContain('收款人前 2')
    expect(card.body).toBeUndefined()
  })

  it('没有块时退回旧行为（正文照排，不凭空造表）', () => {
    const card = buildCard({
      name: 'bill_report',
      args: {},
      content: [{ type: 'text', text: '账单报告（本月）' }],
      isError: false,
      amountConfirmed: true,
    })
    expect(card.body).toBe('账单报告（本月）')
    expect(card.table).toBeUndefined()
  })
})

describe('投影器端到端', () => {
  let cursor = 0
  function ev(type: string, data: unknown): AnySessionEvent {
    cursor += 1
    return { seq: cursor, at: T0, formatVersion: 1, type, data } as unknown as AnySessionEvent
  }

  function callBillReport(projector: WebProjector, callId: string): CardView {
    projector.apply(
      ev('tool/call', {
        callId,
        name: 'bill_report',
        args: { period: 'quarter' },
        tier: { level: 'green' },
        at: T0,
      }),
    )
    const frames = projector.apply(
      ev('tool/result', {
        callId,
        name: 'bill_report',
        isError: false,
        content: [{ type: 'text', text: '账单报告（2026-09 / 2026-10，季度）\n分类汇总：\n- transfer: ¥3,803.70' }],
        durationMs: 5,
      }),
    )
    const frame = frames.find((item) => item.kind === 'tool')
    if (frame === undefined || frame.kind !== 'tool') throw new Error('没有投影出 tool 帧（夹具坏了）')
    if (frame.card === undefined) throw new Error('tool 帧没有卡片（夹具坏了）')
    return frame.card
  }

  it('先落事件再落结果：卡片拿到中文分类表，正文里只剩原始文本也不显示', () => {
    cursor = 0
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('read/bill-report', reportEvent()))

    const card = callBillReport(projector, 'call-bill')
    expect(card.fields.map((field) => field.label)).toContain('账期')
    expect(card.table?.rows[0]?.[0]).toBe('转账')
    expect(card.body).toBeUndefined()
    // 未确认前的原始正文里那个英文键，界面上再也看不到
    expect(JSON.stringify(card)).not.toContain('transfer')
  })

  it('报告块只在本 turn 有效：下一轮没重新读就不画上一轮的数', () => {
    cursor = 0
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('read/bill-report', reportEvent()))
    callBillReport(projector, 'call-bill')

    projector.apply(ev('turn/start', { turn: 2 }))
    const second = callBillReport(projector, 'call-bill-2')
    expect(second.table).toBeUndefined()
    expect(second.body).toContain('账单报告')
  })

  it('失败的报告卡不挂块（这次没读到就是没读到）', () => {
    cursor = 0
    const projector = new WebProjector()
    projector.apply(ev('turn/start', { turn: 1 }))
    projector.apply(ev('read/bill-report', reportEvent()))
    projector.apply(
      ev('tool/call', { callId: 'call-bill', name: 'bill_report', args: {}, tier: { level: 'green' }, at: T0 }),
    )
    const frames = projector.apply(
      ev('tool/result', {
        callId: 'call-bill',
        name: 'bill_report',
        isError: true,
        code: 'tool-failed',
        content: [{ type: 'text', text: '账单报告失败' }],
      }),
    )
    const frame = frames.find((item) => item.kind === 'tool')
    if (frame === undefined || frame.kind !== 'tool' || frame.card === undefined) {
      throw new Error('失败帧也应投影出卡片（夹具坏了）')
    }
    expect(frame.card.table).toBeUndefined()
    expect(frame.card.body).toBe('账单报告失败')
  })
})
