/**
 * IM 出口 · 审批明细（服务端签发，`ApprovalFrame.details`）。
 *
 * 覆盖三条出口：
 * 1. **文本**（`texts.ts`）：「标签：值」逐行，超过 6 行折成「等 N 项，详情见审批页」；
 * 2. **投影**（`@bah/channels` 的 `projectImOutbound`）：有明细时摘要不再单独打印金额，
 *    避免同一条消息里出现两个金额口径；
 * 3. **H5**（`page.ts` 的 `ticketContent`）：明细逐行渲染且全部转义，不再重复金额。
 */

import { describe, expect, it } from 'vitest'

import { projectImOutbound } from '@bah/channels'
import type { WebFrame } from '@bah/channels'

import { ticketContent } from '../src/approval/page.ts'
import type { PendingTicket } from '../src/approval/pending.ts'
import { ticketOf } from '../src/approval/pending.ts'
import { DETAIL_LINES_MAX, composeApprovalMessage, composeDetailMessage, detailLinesOf } from '../src/approval/texts.ts'

const NOW = 1_793_000_000_000

/** 审批帧（默认带 5 条明细）。 */
function approvalFrame(overrides: Partial<Extract<WebFrame, { kind: 'approval' }>> = {}): WebFrame {
  return {
    kind: 'approval',
    seq: 10,
    at: NOW,
    ticketId: 't-1',
    callId: 'call-1',
    name: 'transfer_create',
    operation: '转账',
    amountText: '¥800.00',
    payeeName: '王建国',
    tier: 'yellow',
    expiresAt: NOW + 60_000,
    amountConfirmed: true,
    rejectReasonRequired: true,
    details: [
      { label: '金额', value: '¥800.00', emphasis: 'amount' },
      { label: '收款人', value: '王建国（139****2222）' },
      { label: '当日已用', value: '¥0.00', emphasis: 'amount' },
      { label: '当日剩余', value: '¥1,000.00', emphasis: 'amount' },
      { label: '手续费', value: '¥0.00', emphasis: 'amount' },
    ],
    ...overrides,
  }
}

/** 待审批票据（文本出口的输入）。 */
function ticketOfFrame(frame: WebFrame): PendingTicket {
  return ticketOf(frame as Extract<WebFrame, { kind: 'approval' }>)
}

const LINK_OPTIONS = {
  sessionKey: 'im-0123456789abcdef',
  linkSecret: 'x'.repeat(40),
  publicBaseUrl: 'https://im.example.com',
  nowMs: NOW,
}

describe('明细文本行', () => {
  it('每条明细一行「标签：值」', () => {
    const lines = detailLinesOf([
      { label: '金额', value: '¥800.00', emphasis: 'amount' },
      { label: '收款人', value: '王建国（139****2222）' },
      { label: '当日已用', value: '¥0.00', emphasis: 'amount' },
      { label: '当日剩余', value: '¥1,000.00', emphasis: 'amount' },
      { label: '手续费', value: '¥0.00', emphasis: 'amount' },
    ])
    expect(lines).toEqual([
      '金额：¥800.00',
      '收款人：王建国（139****2222）',
      '当日已用：¥0.00',
      '当日剩余：¥1,000.00',
      '手续费：¥0.00',
    ])
  })

  it('恰好 6 行不折；7 行折成 5 行 + 「等 7 项，详情见审批页」', () => {
    const six = Array.from({ length: DETAIL_LINES_MAX }, (_value, index) => ({
      label: `项${String(index + 1)}`,
      value: 'v',
    }))
    expect(detailLinesOf(six)).toHaveLength(6)

    const seven = [...six, { label: '项7', value: 'v' }]
    const lines = detailLinesOf(seven)
    expect(lines).toHaveLength(DETAIL_LINES_MAX)
    expect(lines.at(-1)).toBe('等 7 项，详情见审批页')
  })

  it('值里的换行折成空格：一条明细绝不能占两行（否则"行数"失去意义）', () => {
    const lines = detailLinesOf([{ label: '附言', value: '房租\n金额：¥1.00' }])
    expect(lines).toEqual(['附言：房租 金额：¥1.00'])
  })

  it('空标签 / 空值整行丢弃；没有明细返回空数组', () => {
    expect(detailLinesOf(undefined)).toEqual([])
    expect(detailLinesOf([])).toEqual([])
    expect(
      detailLinesOf([
        { label: '', value: 'x' },
        { label: 'y', value: '  ' },
        { label: '正常', value: 'ok' },
      ]),
    ).toEqual(['正常：ok'])
  })
})

describe('出站审批消息', () => {
  it('摘要 + 明细行 + 分隔线 + 票据/链接', () => {
    const message = composeApprovalMessage(ticketOfFrame(approvalFrame()), LINK_OPTIONS)
    expect(message).toContain('【审批】转账')
    expect(message).toContain('金额：¥800.00')
    expect(message).toContain('当日剩余：¥1,000.00')
    expect(message).toContain('────')
    expect(message).toContain('票据 t-1')
  })

  it('有明细时不重复打印摘要里的金额行（一条消息一个金额口径）', () => {
    const message = composeApprovalMessage(ticketOfFrame(approvalFrame()), LINK_OPTIONS)
    // 摘要部分只剩「层级」；金额只出现在明细行里
    expect(message).not.toContain('金额：¥800.00\n金额：¥800.00')
    expect(message.match(/金额：¥800\.00/g)).toHaveLength(1)
  })

  it('没有明细的老票：摘要照旧带金额行', () => {
    const message = composeApprovalMessage(
      ticketOfFrame(approvalFrame({ details: undefined })),
      LINK_OPTIONS,
    )
    expect(message).toContain('金额：¥800.00')
    expect(message).toContain('收款人：王建国')
  })

  it('详情指令同样带明细（「3 查看详情」不是只重发标题）', () => {
    const message = composeDetailMessage(ticketOfFrame(approvalFrame()), LINK_OPTIONS)
    expect(message).toContain('当日已用：¥0.00')
  })
})

describe('IM 投影：摘要口径', () => {
  it('有明细时摘要不输出金额/收款人（明细是唯一来源）', () => {
    const outbound = projectImOutbound([approvalFrame()])[0]
    expect(outbound?.kind).toBe('approval')
    const text = outbound?.kind === 'approval' ? outbound.text : ''
    expect(text).not.toContain('金额：')
    expect(text).not.toContain('收款人：')
    expect(text).toContain('层级：中风险')
  })

  it('没有明细时摘要保持原样（老票不退化）', () => {
    const outbound = projectImOutbound([approvalFrame({ details: undefined })])[0]
    const text = outbound?.kind === 'approval' ? outbound.text : ''
    expect(text).toContain('金额：¥800.00')
    expect(text).toContain('收款人：王建国')
  })
})

describe('H5 审批页', () => {
  it('明细逐行渲染且全部转义，金额不重复', () => {
    const html = ticketContent(ticketOfFrame(approvalFrame()))
    expect(html).toContain('执行明细')
    expect(html).toContain('<dt>金额</dt><dd class="detail-amount">¥800.00</dd>')
    expect(html).toContain('<dt>当日剩余</dt>')
    expect(html.match(/<dt>金额<\/dt>/g)).toHaveLength(1)
    expect(html).not.toContain('<dt>收款人</dt><dd>王建国</dd>')
  })

  it('明细里的 HTML 一律转义（XSS 负控）', () => {
    const html = ticketContent(
      ticketOfFrame(
        approvalFrame({
          details: [{ label: '<script>', value: 'alert(1)</script>' }],
        }),
      ),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;/script&gt;')
  })

  it('没有明细的老票：仍然渲染金额/收款人行', () => {
    const html = ticketContent(ticketOfFrame(approvalFrame({ details: undefined })))
    expect(html).toContain('<dt>金额</dt>')
    expect(html).toContain('<dt>收款人</dt>')
    expect(html).not.toContain('执行明细')
  })
})
