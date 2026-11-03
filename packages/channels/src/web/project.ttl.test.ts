/**
 * 审批帧 TTL 透传用例（`approval/asked.expiresAt` → `ApprovalFrame.expiresAt`）。
 *
 * 为什么单独钉这一条：移动壳的倒计时 / 紧迫色 / 读屏播报和 IM 审批页的
 * 「有效期至」全部只读帧上的这一个数。消费方各自的用例是**自己造帧**的，
 * 出账面一旦漏发这个字段，它们照样全绿——只有这里能证明事实真的到了渠道。
 *
 * 纪律与 `project.test.ts` 相同：只喂事件、只断言帧，不读时钟。
 * 渠道**不重算** TTL：`now + ttl` 在票据签发时只算一次，同一份事实只能有一个来源。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { projectSession } from './project.ts'
import type { ApprovalFrame } from './frames.ts'

/** 造事件的游标（每个用例独立编号）。 */
let cursor = 0

function ev(type: string, data: unknown, at = 1_700_000_000_000): AnySessionEvent {
  cursor += 1
  return { seq: cursor, at, formatVersion: 1, type, data } as unknown as AnySessionEvent
}

/** 幕 3 的最小序列：tool/call → approval/asked（TTL 由调用方决定）。 */
function eventsWith(askedExtra: Record<string, unknown>): AnySessionEvent[] {
  cursor = 0
  return [
    ev('turn/start', { turn: 1 }),
    ev('tool/call', {
      callId: 'call-1',
      name: 'transfer_create',
      args: { amount: 800, payee: { name: '王建国' } },
      fingerprint: 'fp-1',
      tier: { level: 'yellow', amountPath: 'amount' },
    }),
    ev('approval/asked', {
      ticketId: 'ticket:call-1',
      callId: 'call-1',
      name: 'transfer_create',
      amount: 800,
      ...askedExtra,
    }),
  ]
}

/** 取审批帧。 */
function approvalOf(askedExtra: Record<string, unknown>): ApprovalFrame {
  const frame = projectSession(eventsWith(askedExtra)).frames.find(
    (item) => item.kind === 'approval',
  )
  expect(frame?.kind).toBe('approval')
  return frame as ApprovalFrame
}

describe('审批帧 TTL 透传', () => {
  it('事件带 expiresAt ⇒ 帧上逐字同一个数（渠道不重算、不取当前时间）', () => {
    // 一个"已经过去"的截止时刻：只要渠道照抄就还是它自己；一旦重算就会变成未来
    const frame = approvalOf({ expiresAt: 1_600_000_000_000 })
    expect(frame.expiresAt).toBe(1_600_000_000_000)
    // 其余六要素不受新增字段影响（金额仍由 args 的元口径格式化）
    expect(frame.amountText).toBe('¥800.00')
    expect(frame.tier).toBe('yellow')
  })

  it('事件没有 expiresAt ⇒ 帧上不出现该键（不编造 TTL）', () => {
    const frame = approvalOf({})
    expect(Object.keys(frame)).not.toContain('expiresAt')
  })

  it('非数字的截止时刻不透传：字符串 / null 一律当缺失', () => {
    for (const value of ['1700000060000', null, true]) {
      const frame = approvalOf({ expiresAt: value })
      expect(Object.keys(frame)).not.toContain('expiresAt')
    }
  })
})
