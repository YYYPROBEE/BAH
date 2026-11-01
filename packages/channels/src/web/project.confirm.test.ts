/**
 * 打字确认（ADR-0008）在投影层的落点：危险工具的审批帧必须带 `confirmText`，
 * 普通工具不得凭空多出该字段。
 *
 * 判定仍在服务端（`http-adapter.ts` 的 `decide`）；这里钉的是"帧与判定读同一张表"，
 * 漏了这个字段，桌面与移动端就不会出现确认输入框，用户也就无从通过服务端校验。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import type { ApprovalFrame } from './frames.ts'
import { WebProjector } from './project.ts'

/** 造一条事件（`seq` 自增；`formatVersion` 固定 1）。 */
let cursor = 0
function ev(type: string, data: unknown): AnySessionEvent {
  cursor += 1
  return {
    seq: cursor,
    at: 1_700_000_000_000,
    formatVersion: 1,
    type,
    data,
  } as unknown as AnySessionEvent
}

/** 走一次工具调用 → 审批，返回投影出的审批帧。 */
function approvalFrameFor(name: string): ApprovalFrame {
  const projector = new WebProjector()
  projector.apply(
    ev('tool/call', {
      callId: 'call-1',
      name,
      args: {},
      fingerprint: 'fp-1',
      tier: { level: 'yellow' },
      at: 1_700_000_000_000,
    }),
  )
  projector.apply(
    ev('approval/asked', { ticketId: 'ticket:call-1', callId: 'call-1', name }),
  )
  const frame = projector.frames().find((item): item is ApprovalFrame => item.kind === 'approval')
  if (frame === undefined) throw new Error('没有投影出审批帧')
  return frame
}

describe('审批帧 · 打字确认', () => {
  it('fact_forget ⇒ confirmText「删除」', () => {
    expect(approvalFrameFor('fact_forget').confirmText).toBe('删除')
  })

  it('plan_disarm ⇒ confirmText「撤销」', () => {
    expect(approvalFrameFor('plan_disarm').confirmText).toBe('撤销')
  })

  it('普通资金操作不带确认词字段（缺省，不是空串）', () => {
    const frame = approvalFrameFor('transfer_create')

    expect('confirmText' in frame).toBe(false)
  })
})
