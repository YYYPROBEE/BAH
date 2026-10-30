/**
 * 帧 → IM 出站投影用例（施工单 01 §5 T-CH-004 / T-CH-005 / T-CH-006）。
 *
 * 判据来自 §2.4 的映射表：**只投影 IM 能承载的呈现面**，审批不带链接。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import type { WebFrame } from '../web/frames.ts'
import { projectImOutbound } from './render.ts'

const AT = 1_700_000_000_000

/** 取出结构化理由码。 */
function codeOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof BahError ? error.code : 'not-bah-error'
  }
}

/** 助手文本消息。 */
function assistant(text: string): WebFrame {
  return { kind: 'message', seq: 1, at: AT, role: 'assistant', blocks: [{ type: 'text', text }] }
}

describe('projectImOutbound：消息与角色（T-CH-004）', () => {
  it('assistant 出文本；多块按行拼接', () => {
    const frames: readonly WebFrame[] = [
      assistant('已受理'),
      {
        kind: 'message',
        seq: 2,
        at: AT,
        role: 'assistant',
        blocks: [
          { type: 'text', text: '第一行' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          { type: 'text', text: '第二行' },
        ],
      },
    ]
    expect(projectImOutbound(frames)).toEqual([
      { kind: 'text', text: '已受理' },
      { kind: 'text', text: '第一行\n[图片]\n第二行' },
    ])
  })

  it('user 消息丢弃（不复读用户自己的话）', () => {
    const frames: readonly WebFrame[] = [
      { kind: 'message', seq: 1, at: AT, role: 'user', blocks: [{ type: 'text', text: '我要转账' }] },
    ]
    expect(projectImOutbound(frames)).toEqual([])
  })

  it('operator 消息带 【坐席】 前缀与显示名', () => {
    const frames: readonly WebFrame[] = [
      {
        kind: 'message',
        seq: 1,
        at: AT,
        role: 'operator',
        blocks: [{ type: 'text', text: '我来处理' }],
        operator: '李四',
      },
      {
        kind: 'message',
        seq: 2,
        at: AT,
        role: 'operator',
        blocks: [{ type: 'text', text: '已接手' }],
      },
    ]
    expect(projectImOutbound(frames)).toEqual([
      { kind: 'text', text: '【坐席】李四：我来处理' },
      { kind: 'text', text: '【坐席】坐席：已接手' },
    ])
  })

  it('空文本与 delta 丢弃', () => {
    const frames: readonly WebFrame[] = [
      { kind: 'message', seq: 1, at: AT, role: 'assistant', blocks: [] },
      { kind: 'delta', at: AT, text: '流式增量' },
    ]
    expect(projectImOutbound(frames)).toEqual([])
  })

  it('其它块给平台摘要', () => {
    const frames: readonly WebFrame[] = [
      {
        kind: 'message',
        seq: 1,
        at: AT,
        role: 'assistant',
        blocks: [{ type: 'other', summary: '附件：交易明细.pdf' }],
      },
    ]
    expect(projectImOutbound(frames)).toEqual([{ kind: 'text', text: '附件：交易明细.pdf' }])
  })

  it('未知块类型 / 未知帧类别 → unreachable-branch（封闭联合不静默吞掉）', () => {
    const badBlock = {
      kind: 'message',
      seq: 1,
      at: AT,
      role: 'assistant',
      blocks: [{ type: 'mystery' }],
    }
    expect(codeOf(() => projectImOutbound([badBlock as unknown as WebFrame]))).toBe('unreachable-branch')
    expect(codeOf(() => projectImOutbound([{ kind: 'mystery' } as unknown as WebFrame]))).toBe(
      'unreachable-branch',
    )
  })
})

describe('projectImOutbound：审批（T-CH-005）', () => {
  it('approval 出摘要：含票据/层级/截止/挑战，不含链接', () => {
    const frames: readonly WebFrame[] = [
      {
        kind: 'approval',
        seq: 1,
        at: AT,
        ticketId: 'ticket:abc',
        callId: 'call-1',
        name: 'transfer_create',
        operation: '转账',
        amountText: '¥1,000.00',
        amountConfirmed: false,
        payeeName: '王五',
        tier: 'red',
        expiresAt: AT + 120_000,
        challenge: 'face',
        rejectReasonRequired: true,
      },
    ]
    const out = projectImOutbound(frames)
    expect(out).toHaveLength(1)
    const first = out[0]
    expect(first?.kind).toBe('approval')
    if (first?.kind !== 'approval') throw new Error('expected approval')
    expect(first.ticketId).toBe('ticket:abc')
    expect(first.tier).toBe('red')
    expect(first.expiresAt).toBe(AT + 120_000)
    expect(first.challenge).toBe('face')
    expect(first.text).toContain('转账')
    expect(first.text).toContain('¥1,000.00')
    expect(first.text).toContain('王五')
    expect(first.text).toContain('高风险')
    expect(first.text).toContain('人脸识别')
    // 投影层不生成链接（签名在 03 单）
    expect(first.text).not.toContain('http')
  })

  it('金额未确认时写"待确认"，缺省字段不编造', () => {
    const frames: readonly WebFrame[] = [
      {
        kind: 'approval',
        seq: 1,
        at: AT,
        ticketId: 'ticket:x',
        callId: 'call-x',
        name: 'transfer_create',
        operation: '转账',
        amountConfirmed: false,
        tier: 'unknown',
        rejectReasonRequired: false,
      },
    ]
    const out = projectImOutbound(frames)
    const first = out[0]
    expect(first?.kind).toBe('approval')
    if (first?.kind !== 'approval') throw new Error('expected approval')
    expect(first.text).toContain('金额：待确认')
    expect(first.text).toContain('未标注')
    expect(first.expiresAt).toBeUndefined()
    expect(first.challenge).toBeUndefined()
  })
})

describe('projectImOutbound：收尾 / 提示 / 拦截 / 接管（T-CH-006）', () => {
  it('approval-closed 出结论文本（理由与代码可选）', () => {
    expect(
      projectImOutbound([
        {
          kind: 'approval-closed',
          seq: 1,
          at: AT,
          ticketId: 'ticket:abc',
          decision: 'rejected',
          label: '已拒绝',
          reason: '金额不对',
          code: 'reason-required',
        },
      ]),
    ).toEqual([{ kind: 'text', text: '【审批结果】已拒绝（rejected）\n理由：金额不对\n代码：reason-required' }])
  })

  it('notice warning/danger 出提示；info/success 丢弃', () => {
    const warning: WebFrame = {
      kind: 'notice',
      seq: 1,
      at: AT,
      level: 'warning',
      title: '人工接管',
      text: '请稍候',
      code: 'handoff',
    }
    const danger: WebFrame = { kind: 'notice', seq: 2, at: AT, level: 'danger', title: '安全拦截' }
    const info: WebFrame = { kind: 'notice', seq: 3, at: AT, level: 'info', title: '提示' }
    const success: WebFrame = { kind: 'notice', seq: 4, at: AT, level: 'success', title: '完成' }
    expect(projectImOutbound([warning, danger, info, success])).toEqual([
      { kind: 'text', text: '【提示】人工接管：请稍候（handoff）' },
      { kind: 'text', text: '【提示】安全拦截' },
    ])
  })

  it('tool denied 出拦截文本；pending/done 丢弃', () => {
    const denied: WebFrame = {
      kind: 'tool',
      seq: 1,
      at: AT,
      callId: 'call-1',
      name: 'transfer_create',
      title: '转账',
      state: 'denied',
      tier: 'red',
      amountConfirmed: false,
      reason: '超出日限额',
      code: 'limit-exceeded',
    }
    const pending: WebFrame = { ...denied, seq: 2, state: 'pending' }
    const done: WebFrame = { ...denied, seq: 3, state: 'done' }
    expect(projectImOutbound([denied, pending, done])).toEqual([
      { kind: 'text', text: '【已拦截】transfer_create：超出日限额（limit-exceeded）' },
    ])
  })

  it('handoff 进入/交回都出文本', () => {
    const enter: WebFrame = { kind: 'handoff', seq: 1, at: AT, active: true, reason: '转人工', operator: '李四' }
    const leave: WebFrame = { kind: 'handoff', seq: 2, at: AT, active: false }
    expect(projectImOutbound([enter, leave])).toEqual([
      { kind: 'handoff', text: '【转人工】已进入人工服务（坐席：李四）：转人工' },
      { kind: 'handoff', text: '【转人工】已交回智能助手' },
    ])
  })

  it('表外帧（dag/audit/snapshot/turn/todo…）一律丢弃', () => {
    const frames: readonly WebFrame[] = [
      { kind: 'turn', seq: 1, at: AT, turn: 1, phase: 'start' },
      {
        kind: 'audit',
        seq: 2,
        at: AT,
        timeText: '00:00:00',
        category: 'tool',
        label: '工具',
        summary: '调用',
      },
      { kind: 'snapshot', sessionId: 's', maxSeq: 2, frames: [] },
      { kind: 'handoff-warn', seq: 3, at: AT, waitedMs: 1, slaMs: 2 },
    ]
    expect(projectImOutbound(frames)).toEqual([])
  })

  it('choice 帧投影出问题与候选文字（不编号：回填走 label 而非序号）', () => {
    const frames: readonly WebFrame[] = [
      {
        kind: 'choice',
        seq: 1,
        at: AT,
        callId: 'call-ask',
        prompt: '要转给谁？请给出收款人姓名。',
        options: [
          { id: 'a', label: '王建国' },
          { id: 'b', label: '张伟', hint: '最近转账' },
        ],
        allowFreeText: true,
      },
    ]
    expect(projectImOutbound(frames)).toEqual([
      {
        kind: 'text',
        text: '【请选择】要转给谁？请给出收款人姓名。\n· 王建国\n· 张伟（最近转账）\n回复候选文字，或直接输入。',
      },
    ])
  })
})
