/**
 * 审计时间线的金额口径（施工单 13 §2.1）。
 *
 * 这一条守着一个**已发生过的事故**：`approval/asked.amount` 是**元**，
 * 而 `formatCents` 吃**分**。审计时间线原先直接 `formatCents(amount)`，
 * 于是审批弹窗把 800 元显示成 ¥8.00——差 100 倍，且恰好出现在用户点"确认"的那一刻。
 *
 * 聊天帧那条路径（`project.ts`）一直是对的（它显式 `amount * 100`）。
 * 两条路径读同一个事件却算出不同金额，正是"跨层口径"最典型的坏味道，
 * 所以这里同时钉住"单条事件的审计摘要"和"两侧一致"。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { auditOf } from './audit.ts'
import { WebProjector } from './project.ts'

/** 造一条会话事件（审计时间线只读 seq / at / type / data）。 */
function event(type: string, data: Record<string, unknown>, seq = 1): {
  seq: number
  at: number
  type: string
  data: unknown
} {
  return { seq, at: 1_700_000_000_000, type, data }
}

describe('审计时间线：approval/asked 的金额是元，不是分', () => {
  it('800 元 → ¥800.00（不是 ¥8.00）', () => {
    const frame = auditOf(event('approval/asked', { ticketId: 'ticket:call-1', name: 'transfer_create', amount: 800 }))

    expect(frame?.summary).toContain('¥800.00')
    expect(frame?.summary).not.toContain('¥8.00')
  })

  it('带小数的金额按分四舍五入（1,234.5 元 → ¥1,234.50）', () => {
    const frame = auditOf(event('approval/asked', { name: 'transfer_create', amount: 1_234.5 }))

    expect(frame?.summary).toContain('¥1,234.50')
  })

  it('没有金额时只说"请求执行 <工具>"，不补 0', () => {
    const frame = auditOf(event('approval/asked', { name: 'transfer_create' }))

    expect(frame?.summary).toBe('请求执行 transfer_create')
  })

  it('与聊天帧同源：同一条事件的审批金额文本一致', () => {
    const asked = event('approval/asked', {
      ticketId: 'ticket:call-1',
      callId: 'call-1',
      name: 'transfer_create',
      amount: 800,
    })

    const audited = auditOf({ ...asked, seq: 1 })

    // 聊天帧在"参数缺金额"时退回事件值，正是本次出问题的分支：
    // 这里不先喂 tool/call，让投影器只能走 `data.amount * 100`
    const projector = new WebProjector()
    const frames = projector.apply({ ...asked, formatVersion: 1 } as unknown as AnySessionEvent)
    const approval = frames.find((frame) => frame.kind === 'approval')

    expect(approval).toBeDefined()
    const amountText = (approval as { amountText?: string }).amountText
    expect(amountText).toBe('¥800.00')
    expect(audited?.summary).toContain(amountText ?? '<缺失>')
  })
})
