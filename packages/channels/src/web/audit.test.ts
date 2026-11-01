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

describe('审计时间线：订阅域事件（ADR-0007 四键）', () => {
  it('read/subscriptions 报清单条数、推断条数与取证窗口', () => {
    const frame = auditOf(
      event('read/subscriptions', {
        result: {
          confirmed: [{ subscriptionId: 's-1' }, { subscriptionId: 's-2' }],
          detected: [{ merchantKey: 'm-1' }],
        },
        detectedAt: 1_700_000_000_000,
        basis: { from: 1_697_408_000_000, to: 1_700_000_000_000, txnCount: 42 },
        detectorVersion: 'r1',
      }),
    )

    expect(frame?.category).toBe('subscription')
    expect(frame?.label).toBe('订阅清单')
    expect(frame?.summary).toBe('2 项订阅 · 推断 1 条 · 近 30 天 42 笔')
  })

  it('read/subscriptions 缺 basis 时只说条数（不拿 0 冒充"没有流水"）', () => {
    const frame = auditOf(event('read/subscriptions', { result: { confirmed: [], detected: [] } }))

    expect(frame?.summary).toBe('0 项订阅 · 推断 0 条')
    expect(frame?.summary).not.toContain('笔')
  })

  it('sub/cancelled 用商户名，退订影响面不写成"协议关闭"', () => {
    const frame = auditOf(event('sub/cancelled', { subscriptionId: 's-video', merchant: '视频会员', at: 1 }))

    expect(frame?.category).toBe('subscription')
    expect(frame?.label).toBe('订阅已取消')
    expect(frame?.summary).toBe('视频会员')
  })

  it('sub/authorization-revoked 带上受影响订阅数', () => {
    const frame = auditOf(
      event('sub/authorization-revoked', {
        authorizationId: 'a-1',
        merchant: '某某健身',
        affected: 2,
        at: 1,
      }),
    )

    expect(frame?.label).toBe('代扣协议已关闭')
    expect(frame?.summary).toBe('某某健身 · 影响 2 项')
  })

  it('sub/watch-updated 的三种模式都有中文文案', () => {
    const remind = auditOf(event('sub/watch-updated', { subscriptionId: 's-1', watch: 'remind', aheadDays: 3 }))
    const idle = auditOf(event('sub/watch-updated', { subscriptionId: 's-1', watch: 'idle' }))
    const none = auditOf(event('sub/watch-updated', { subscriptionId: 's-1', watch: 'none' }))

    expect(remind?.summary).toBe('到期提醒 · 提前 3 天')
    expect(idle?.summary).toBe('闲置标记')
    expect(none?.summary).toBe('已清除标记')
  })

  it('未知事件仍然不进时间线（域事件白名单不外溢）', () => {
    expect(auditOf(event('sub/whatever', {}))).toBeUndefined()
  })
})

describe('审计时间线：订阅域事件的兜底口径（只说载荷里有的）', () => {
  it('sub/cancelled 缺商户时退回短 ID，两者都缺也不留空行', () => {
    const byId = auditOf(event('sub/cancelled', { subscriptionId: 'sub:s-video' }))
    const empty = auditOf(event('sub/cancelled', {}))

    expect(byId?.summary).toBe('s-video')
    expect(empty?.summary).toBe('订阅已取消')
    expect(empty?.summary).not.toBe('')
  })

  it('sub/authorization-revoked 缺商户写"代扣协议"，缺受影响数就不报"影响 N 项"', () => {
    const noMerchant = auditOf(event('sub/authorization-revoked', { authorizationId: 'a-1' }))
    const noCount = auditOf(event('sub/authorization-revoked', { merchant: '某某健身' }))

    expect(noMerchant?.summary).toBe('代扣协议')
    expect(noCount?.summary).toBe('某某健身')
    expect(noCount?.summary).not.toContain('影响')
  })

  it('sub/watch-updated 缺 watch 按默认提醒；未知模式原样透出（不猜成提醒）', () => {
    const missing = auditOf(event('sub/watch-updated', { subscriptionId: 's-1' }))
    const unknown = auditOf(event('sub/watch-updated', { subscriptionId: 's-1', watch: 'weekly' }))

    expect(missing?.summary).toBe('到期提醒')
    expect(unknown?.summary).toBe('weekly')
  })

  it('read/subscriptions 载荷残缺时按 0 条报，不抛错；basis 不全就不写流水笔数', () => {
    const noResult = auditOf(event('read/subscriptions', {}))
    const partialBasis = auditOf(
      event('read/subscriptions', {
        result: { confirmed: [{ subscriptionId: 's-1' }], detected: [] },
        basis: { from: 1_697_408_000_000, to: 1_700_000_000_000 },
      }),
    )

    expect(noResult?.summary).toBe('0 项订阅 · 推断 0 条')
    expect(partialBasis?.summary).toBe('1 项订阅 · 推断 0 条')
    expect(partialBasis?.summary).not.toContain('笔')
  })

  it('事件载荷不是对象时不抛错（时间线坏了不能拖垮对话）', () => {
    expect(() => auditOf({ seq: 1, at: 1_700_000_000_000, type: 'approval/asked', data: null })).not.toThrow()
    expect(auditOf({ seq: 1, at: 1_700_000_000_000, type: 'approval/asked', data: null })?.summary).toBe(
      '请求执行 未知操作',
    )
  })
})

describe('审计时间线：风险测评两键（R-6）', () => {
  it('read/risk-questions → 「查看风险问卷」+ 题数与版本；分类复用 tool', () => {
    const frame = auditOf(
      event('read/risk-questions', {
        callId: 'call-1',
        questionnaireId: 'rq-1',
        version: 'risk-q/v1',
        questions: [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 5 }],
      }),
    )

    expect(frame?.category).toBe('tool')
    expect(frame?.label).toBe('查看风险问卷')
    expect(frame?.summary).toBe('查看风险问卷 · 5 题 · risk-q/v1')
  })

  it('risk/assessed → 「风险测评：R2 → R5（5 题）」', () => {
    const answers = [1, 2, 3, 4, 5].map((index) => ({ index, key: 'aggressive' }))
    const frame = auditOf(
      event('risk/assessed', {
        questionnaireId: 'rq-1',
        version: 'risk-q/v1',
        confirmedBy: 'approval-ticket',
        ticketRef: 'ticket:call-1',
        answers,
        result: { action: 'submit', answers, score: 25, from: 'R2', to: 'R5' },
      }),
    )

    expect(frame?.label).toBe('风险测评')
    expect(frame?.summary).toBe('风险测评：R2 → R5（5 题）')
    expect(frame?.toolName).toBe('risk_assess')
  })

  it('载荷残缺时不编造等级或题数（只说"已落档" / "查看风险问卷"），也不抛错', () => {
    expect(() => auditOf(event('risk/assessed', {}))).not.toThrow()
    expect(auditOf(event('risk/assessed', {}))?.summary).toBe('风险测评已落档')
    expect(auditOf(event('read/risk-questions', {}))?.summary).toBe('查看风险问卷')
    // 只有一半字段：from 在、to 缺 → 不写半截等级；空答案数组也不写「0 题」
    expect(auditOf(event('risk/assessed', { result: { from: 'R2' }, answers: [] }))?.summary).toBe(
      '风险测评已落档',
    )
  })
})

describe('审计时间线：可展开明细', () => {
  it('sentry/trace 的摘要说轨迹类型，明细带 kind / turn / callId / name', () => {
    const frame = auditOf(
      event('sentry/trace', {
        ts: '2026-11-01T08:18:51.055Z',
        seq: 2,
        kind: 'tool-call',
        turn: 1,
        callId: 'call-1',
        name: 'account_balance',
        session: 'desktop-test',
      }),
    )

    expect(frame?.summary).toContain('tool-call')
    expect(frame?.summary).not.toContain('命中')
    expect(frame?.detail).toEqual(
      expect.arrayContaining([
        { label: '类型', value: 'tool-call' },
        { label: '轮次', value: '1' },
        { label: '调用 ID', value: 'call-1' },
        { label: '工具', value: 'account_balance' },
      ]),
    )
  })

  it('明细只收白名单字段：工具参数 / 结果 / 会话 ID 不进帧', () => {
    const frame = auditOf(
      event('tool/result', {
        name: 'transfer_create',
        callId: 'call-1',
        isError: false,
        result: { secret: 'x' },
        args: { password: 'y' },
        session: 'desktop-test',
      }),
    )
    const labels = (frame?.detail ?? []).map((item) => item.label)
    const values = (frame?.detail ?? []).map((item) => item.value)
    expect(labels).toContain('工具')
    expect(labels).toContain('调用 ID')
    expect(labels).not.toContain('result')
    expect(labels).not.toContain('args')
    expect(labels).not.toContain('session')
    expect(values.join(' ')).not.toContain('secret')
    expect(values.join(' ')).not.toContain('password')
  })

  it('审批请求的明细带票据/工具/明细项；金额仍以摘要的格式化文本为准', () => {
    const frame = auditOf(
      event('approval/asked', {
        ticketId: 'ticket:call-1',
        name: 'transfer_create',
        amount: 800,
        details: [{ label: '收款人' }, { label: '金额' }],
      }),
    )
    expect(frame?.detail).toEqual(
      expect.arrayContaining([
        { label: '票据', value: 'ticket:call-1' },
        { label: '工具', value: 'transfer_create' },
        { label: '明细项', value: '收款人、金额' },
      ]),
    )
    expect(frame?.summary).toContain('¥800.00')
  })
})
