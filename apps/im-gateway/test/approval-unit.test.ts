/**
 * 审批纯函数面（03 单）：待审批表 / 指令选择 / 文案 / 六码翻译。
 */

import { describe, expect, it } from 'vitest'

import type { ApprovalClosedFrame, ApprovalFrame } from '@bah/channels'

import { applyPendingFrame, markVerified, rebuildPending, ticketOf } from '../src/approval/pending.ts'
import { planApprovalCommand } from '../src/approval/commands.ts'
import {
  composeApprovalMessage,
  composeDetailMessage,
  closedTextOf,
  EXPIRED_TEXT,
  NEED_TICKET_TEXT,
  NEED_VERIFY_TEXT,
  NO_CHALLENGE_TEXT,
  NO_PENDING_TEXT,
  UNKNOWN_TICKET_TEXT,
} from '../src/approval/texts.ts'
import { mapDecideResult, mapHandoffResult, mapVerifyResult } from '../src/approval/submit.ts'

const NOW = 1_793_000_000_000
const SESSION = 'im-0123456789abcdef'
const SECRET = 'link-secret-0123456789abcdefghij'

function approval(overrides: Partial<ApprovalFrame> = {}): ApprovalFrame {
  return {
    kind: 'approval',
    seq: 1,
    at: NOW,
    ticketId: 't-1',
    callId: 'call-1',
    name: 'transfer_create',
    operation: '转账',
    amountText: '100 元',
    payeeName: '张三',
    tier: 'yellow',
    expiresAt: NOW + 60_000,
    amountConfirmed: false,
    rejectReasonRequired: true,
    ...overrides,
  }
}

function closed(overrides: Partial<ApprovalClosedFrame> = {}): ApprovalClosedFrame {
  return {
    kind: 'approval-closed',
    seq: 2,
    at: NOW,
    ticketId: 't-1',
    decision: 'rejected',
    label: '已拒绝',
    ...overrides,
  }
}

describe('待审批表', () => {
  it('快照重建：closed 优先，未收尾的保留', () => {
    const pending = rebuildPending([approval(), approval({ ticketId: 't-2', seq: 3 }), closed()])
    expect([...pending.keys()]).toEqual(['t-2'])
  })

  it('同票据重复审批帧 → 更新而不是新增；verified 保留', () => {
    const ticket = { ...ticketOf(approval({ tier: 'red' })), verified: true }
    const pending = new Map([[ticket.ticketId, ticket]])
    const change = applyPendingFrame(pending, approval({ tier: 'red', amountText: '200 元', seq: 5 }))
    expect(change?.kind).toBe('updated')
    expect(pending.get('t-1')?.verified).toBe(true)
    expect(pending.get('t-1')?.amountText).toBe('200 元')
    markVerified(pending, 't-1')
    expect(pending.get('t-1')?.verified).toBe(true)
  })
})

describe('指令选择（T-H5-004 / T-IM-016）', () => {
  const yellow = ticketOf(approval())
  const red = ticketOf(approval({ ticketId: 't-red', tier: 'red', challenge: 'face' }))

  it('0 张 → 当前没有待审批；多张 → 要求带票号', () => {
    expect(planApprovalCommand({ kind: 'approve' }, [])).toMatchObject({ kind: 'reply', text: NO_PENDING_TEXT })
    expect(planApprovalCommand({ kind: 'approve' }, [yellow, red])).toMatchObject({
      kind: 'reply',
      text: NEED_TICKET_TEXT,
    })
  })

  it('恰好一张 → 选中；红级未验证 → 先提示验证', () => {
    expect(planApprovalCommand({ kind: 'approve' }, [yellow])).toMatchObject({
      kind: 'decide',
      ticketId: 't-1',
      decision: 'allowed-once',
    })
    expect(planApprovalCommand({ kind: 'approve' }, [red])).toMatchObject({
      kind: 'reply',
      text: NEED_VERIFY_TEXT,
    })
  })

  it('红级已 verified → 可批准', () => {
    const verified = { ...red, verified: true }
    expect(planApprovalCommand({ kind: 'approve' }, [verified])).toMatchObject({
      kind: 'decide',
      ticketId: 't-red',
    })
  })

  it('带票号但本地没有 → 照样转发由子进程裁决（只有详情在本地判不存在）', () => {
    expect(planApprovalCommand({ kind: 'approve', ticketId: 't-ghost' }, [])).toMatchObject({
      kind: 'decide',
      ticketId: 't-ghost',
    })
    expect(planApprovalCommand({ kind: 'detail', ticketId: 't-ghost' }, [])).toMatchObject({
      kind: 'reply',
      text: UNKNOWN_TICKET_TEXT,
    })
  })

  it('拒绝：票号可选，理由随计划走', () => {
    expect(planApprovalCommand({ kind: 'reject', reason: '金额不对' }, [yellow])).toMatchObject({
      kind: 'decide',
      ticketId: 't-1',
      decision: 'rejected',
      reason: '金额不对',
    })
  })

  it('验证：无挑战 → 不需要强验证；有挑战 → verify', () => {
    expect(planApprovalCommand({ kind: 'verify' }, [yellow])).toMatchObject({
      kind: 'reply',
      text: NO_CHALLENGE_TEXT,
    })
    expect(planApprovalCommand({ kind: 'verify' }, [red])).toMatchObject({
      kind: 'verify',
      ticketId: 't-red',
    })
  })

  it('显式票号指向已知红级未验证票 → 先验证，verified 后才批准', () => {
    expect(planApprovalCommand({ kind: 'approve', ticketId: 't-red' }, [red])).toMatchObject({
      kind: 'reply',
      text: NEED_VERIFY_TEXT,
    })
    expect(
      planApprovalCommand({ kind: 'approve', ticketId: 't-red' }, [{ ...red, verified: true }]),
    ).toMatchObject({ kind: 'decide', ticketId: 't-red', decision: 'allowed-once' })
  })

  it('显式票号拒绝：即使本地没有该票也按票号转发，理由原样携带', () => {
    expect(
      planApprovalCommand({ kind: 'reject', ticketId: 't-ghost', reason: '金额不对' }, []),
    ).toEqual({
      kind: 'decide',
      ticketId: 't-ghost',
      decision: 'rejected',
      reason: '金额不对',
    })
  })

  it('强验证：显式票号先查本地挑战；多张且无票号不猜', () => {
    expect(planApprovalCommand({ kind: 'verify', ticketId: 't-1' }, [yellow])).toMatchObject({
      kind: 'reply',
      text: NO_CHALLENGE_TEXT,
    })
    expect(planApprovalCommand({ kind: 'verify', ticketId: 't-red' }, [red])).toEqual({
      kind: 'verify',
      ticketId: 't-red',
    })
    expect(planApprovalCommand({ kind: 'verify' }, [yellow, red])).toMatchObject({
      kind: 'reply',
      text: NEED_TICKET_TEXT,
    })
  })

  it('详情：无票号只在恰好一张时选中；0 张 / 多张都不猜', () => {
    expect(planApprovalCommand({ kind: 'detail' }, [yellow])).toEqual({
      kind: 'detail',
      ticketId: 't-1',
    })
    expect(planApprovalCommand({ kind: 'detail', ticketId: 't-1' }, [yellow])).toEqual({
      kind: 'detail',
      ticketId: 't-1',
    })
    expect(planApprovalCommand({ kind: 'detail' }, [])).toMatchObject({
      kind: 'reply',
      text: NO_PENDING_TEXT,
    })
    expect(planApprovalCommand({ kind: 'detail' }, [yellow, red])).toMatchObject({
      kind: 'reply',
      text: NEED_TICKET_TEXT,
    })
  })
})

describe('出站文案（§2.5）', () => {
  const ticket = ticketOf(approval())

  it('有公开基址 → 带签名链接；无 → 省略 H5 行', () => {
    const withLink = composeApprovalMessage(ticket, {
      sessionKey: SESSION,
      linkSecret: SECRET,
      publicBaseUrl: 'https://im.example.test',
      nowMs: NOW,
    })
    expect(withLink).toContain('https://im.example.test/a/')
    const without = composeApprovalMessage(ticket, {
      sessionKey: SESSION,
      linkSecret: SECRET,
      publicBaseUrl: undefined,
      nowMs: NOW,
    })
    expect(without).not.toContain('H5：')
    expect(without).toContain('回复：1 批准一次')
  })

  it('红级追加强验证提示；详情只发摘要 + 链接', () => {
    const red = ticketOf(approval({ tier: 'red', challenge: 'face' }))
    const text = composeApprovalMessage(red, {
      sessionKey: SESSION,
      linkSecret: SECRET,
      publicBaseUrl: 'https://im.example.test',
      nowMs: NOW,
    })
    expect(text).toContain('需强验证')
    expect(composeDetailMessage(ticket, {
      sessionKey: SESSION,
      linkSecret: SECRET,
      publicBaseUrl: 'https://im.example.test',
      nowMs: NOW,
    })).toContain('/a/')
  })

  it('收尾 unavailable → 明确写"已过期"', () => {
    expect(closedTextOf(closed({ decision: 'unavailable', label: '不可用' }))).toContain(EXPIRED_TEXT)
  })
})

describe('子进程结果翻译（六码）', () => {
  const codes = [
    ['unknown-ticket'],
    ['foreign-ticket'],
    ['invalid-decision'],
    ['reason-required'],
    ['already-decided'],
    ['expired'],
  ] as const

  it('每个错误码都有中文文案，且不把内部码塞进用户文案', () => {
    for (const [code] of codes) {
      const mapped = mapDecideResult(
        { status: 400, json: { error: { code } }, text: '' },
        'allowed-once',
      )
      expect(mapped.ok).toBe(false)
      expect(mapped.text.length).toBeGreaterThan(0)
      expect(mapped.text).not.toContain(code)
    }
  })

  it('200 → 已批准 / 已拒绝；强验证 no-challenge；转人工 409', () => {
    expect(mapDecideResult({ status: 200, json: {}, text: '' }, 'allowed-once').text).toBe('已批准')
    expect(mapDecideResult({ status: 200, json: {}, text: '' }, 'rejected').text).toBe('已拒绝')
    expect(
      mapVerifyResult({ status: 400, json: { error: { code: 'no-challenge' } }, text: '' }).text,
    ).toBe(NO_CHALLENGE_TEXT)
    expect(mapHandoffResult({ status: 409, json: {}, text: '' }).text).toBe('已在人工服务中')
  })

  it('网络失败 / 未知码 → 处理失败（不抛）', () => {
    expect(mapDecideResult({ status: 0, json: undefined, text: '' }, 'allowed-once').ok).toBe(false)
    expect(mapVerifyResult({ status: 500, json: undefined, text: '' }).ok).toBe(false)
  })
})
