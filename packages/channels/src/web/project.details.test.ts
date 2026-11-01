/**
 * 审批明细投影用例（`approval/asked.details` → `ApprovalFrame.details`）。
 *
 * 四条纪律，每条都有负控：
 * 1. **原样**：帧上的 label / value / emphasis 与事件逐字相同；金额不做二次格式化
 *    （事件里写 `800.00` 就显示 `800.00`，不会变成 `¥800.00`）；
 * 2. **形状守卫只剔除**：非对象 / 空 label / 空 value / 未知 emphasis 丢掉，不抛错；
 * 3. **上限**：超过 `DETAILS_MAX_ROWS` 截断并置 `detailsTruncated`（完整内容仍在事件里）；
 * 4. **审计可回放**：`auditOf(approval/asked)` 的摘要含明细标签集合。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { auditOf } from './audit.ts'
import { DETAILS_MAX_ROWS, projectApprovalDetails, projectSession } from './project.ts'
import type { ApprovalFrame } from './frames.ts'

let cursor = 0

/** 造一条事件（`seq` 自增）。 */
function ev(type: string, data: unknown, at = 1_700_000_000_000): AnySessionEvent {
  cursor += 1
  return { seq: cursor, at, formatVersion: 1, type, data } as unknown as AnySessionEvent
}

/** 幕 3 的最小序列：tool/call → approval/asked（带 details）。 */
function eventsWith(details: unknown): AnySessionEvent[] {
  cursor = 0
  return [
    ev('turn/start', { turn: 1 }),
    ev('tool/call', {
      callId: 'call-1',
      name: 'transfer_create',
      args: { amount: 800, payee: { name: '王建国', phone: '13900002222' } },
      fingerprint: 'fp-1',
      tier: { level: 'yellow', amountPath: 'amount' },
      at: 1_700_000_000_000,
    }),
    ev('approval/asked', {
      ticketId: 'ticket:call-1',
      callId: 'call-1',
      name: 'transfer_create',
      amount: 800,
      details,
    }),
  ]
}

/** 取审批帧。 */
function approvalOf(details: unknown): ApprovalFrame {
  const frames = projectSession(eventsWith(details)).frames
  const frame = frames.find((item) => item.kind === 'approval')
  expect(frame?.kind).toBe('approval')
  return frame as ApprovalFrame
}

const DETAILS = [
  { label: '金额', value: '¥800.00', emphasis: 'amount' },
  { label: '收款人', value: '王建国（139****2222）' },
  { label: '当日剩余', value: '¥1,000.00', emphasis: 'amount' },
]

describe('审批帧明细投影', () => {
  it('原样投影：标签/值/强调逐字一致', () => {
    const frame = approvalOf(DETAILS)
    expect(frame.details).toEqual(DETAILS)
    expect(frame.detailsTruncated).toBeUndefined()
  })

  it('不做二次计算：事件里是 `800.00` 就显示 `800.00`（不套 ¥、不补零）', () => {
    const frame = approvalOf([{ label: '金额', value: '800.00', emphasis: 'amount' }])
    expect(frame.details?.[0]?.value).toBe('800.00')
    // 同一帧的 amountText 仍由 formatCents 从分格式化（既有口径不变）
    expect(frame.amountText).toBe('¥800.00')
  })

  it('缺字段 / 类型不对：整行剔除，不抛错', () => {
    const frame = approvalOf([
      { label: '金额', value: '¥800.00' },
      { label: '', value: '空标签' },
      { label: '空值', value: '   ' },
      { value: '没有标签' },
      null,
      'not-an-object',
      { label: '未知强调', value: 'x', emphasis: 'rainbow' },
    ])
    expect(frame.details).toEqual([
      { label: '金额', value: '¥800.00' },
      { label: '未知强调', value: 'x' },
    ])
  })

  it('缺省 / 非数组 / 空数组：帧上不出现 details', () => {
    for (const value of [undefined, null, 'x', {}, []]) {
      const frame = approvalOf(value)
      expect(frame.details).toBeUndefined()
      expect(frame.detailsTruncated).toBeUndefined()
    }
  })

  it('控制字符折成空格：一条值不能靠换行伪造出第二行', () => {
    const frame = approvalOf([{ label: '附言', value: '房租\n金额：¥1.00' }])
    expect(frame.details?.[0]?.value).toBe('房租 金额：¥1.00')
  })

  it('超过上限截断并标记（完整内容仍在事件里）', () => {
    const many = Array.from({ length: DETAILS_MAX_ROWS + 3 }, (_value, index) => ({
      label: `项 ${String(index + 1)}`,
      value: `值 ${String(index + 1)}`,
    }))
    const frame = approvalOf(many)
    expect(frame.details).toHaveLength(DETAILS_MAX_ROWS)
    expect(frame.detailsTruncated).toBe(true)
  })
})

describe('projectApprovalDetails 单独入口', () => {
  it('空输入返回空对象（不产生 `details: []`）', () => {
    expect(projectApprovalDetails(undefined)).toEqual({})
    expect(projectApprovalDetails([])).toEqual({})
  })
})

describe('审计时间线的明细标签集合', () => {
  it('摘要里带明细项数与标签（回放能说"用户当时看到了什么"）', () => {
    cursor = 0
    const frame = auditOf(
      ev('approval/asked', {
        ticketId: 'ticket:call-1',
        callId: 'call-1',
        name: 'transfer_create',
        amount: 800,
        details: DETAILS,
      }),
    )
    expect(frame?.summary).toBe('请求执行 transfer_create · ¥800.00 · 明细 3 项：金额/收款人/当日剩余')
  })

  it('没有明细：摘要与原来逐字一致（不出现"明细 0 项"）', () => {
    cursor = 0
    const frame = auditOf(
      ev('approval/asked', { ticketId: 'ticket:call-1', callId: 'call-1', name: 'card_freeze' }),
    )
    expect(frame?.summary).toBe('请求执行 card_freeze')
  })

  it('标签过多折叠成「等 N 项」', () => {
    cursor = 0
    const many = Array.from({ length: 11 }, (_value, index) => ({
      label: `项${String(index + 1)}`,
      value: 'v',
    }))
    const frame = auditOf(
      ev('approval/asked', { ticketId: 't', callId: 'c', name: 'x', details: many }),
    )
    expect(frame?.summary).toContain('等 11 项')
  })
})
