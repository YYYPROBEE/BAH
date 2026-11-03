/**
 * 转账工具。
 *
 * 这里覆盖工具体与票据桥接；`ask + 票据签发 + 审批` 的完整链路在 `governance.test.ts`。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import type { TicketId } from '@bah/core'

import { bankIds } from '../core/index.ts'
import type { TransferCreatedResult, TransferPreviewResult } from './dto.ts'
import { fingerprintOf } from './fingerprint.ts'
import { createBankHarness } from './testing.ts'

/** 给某个调用签发并批准一张五绑定票据。 */
function approveTicket(
  h: ReturnType<typeof createBankHarness>,
  callId: string,
  args: Readonly<Record<string, unknown>>,
  amountCents: number,
): void {
  const now = h.deps.now?.() ?? 0
  const ticketId = `ticket:${callId}` as TicketId
  h.core.tickets.issue(
    ticketId,
    {
      sessionId: h.ctx.sessionId,
      tool: 'transfer_create',
      fingerprint: fingerprintOf('transfer_create', args),
      amountCents,
      expiresAt: now + 120_000,
    },
    now,
  )
  h.core.tickets.approve(ticketId, now)
}

describe('transfer_preview', () => {
  it('指定 viaCardId：预检带回卡尾号与状态，正文出现「本笔使用卡尾号」', async () => {
    const h = createBankHarness()
    const args = {
      amount: 800,
      payee: { name: '王建国', phone: '13900002222' },
      viaCardId: 'c-1',
    }
    const result = (await h.call('transfer_preview', args)) as TransferPreviewResult
    expect(result.viaCardTail).toBe('1234')
    expect(result.viaCardStatus).toBe('normal')

    const tool = h.tools.get('transfer_preview')!
    const text = ((tool.projectContent?.(result) ?? [])[0] as { text: string }).text
    expect(text).toContain('本笔使用卡尾号 1234（正常）')
  })

  it('不传 viaCardId：结果不含卡字段（零回归）', async () => {
    const h = createBankHarness()
    const result = (await h.call('transfer_preview', {
      amount: 800,
      payee: { name: '王建国', phone: '13900002222' },
    })) as TransferPreviewResult
    expect(result.viaCardTail).toBeUndefined()
    expect(result.viaCardStatus).toBeUndefined()
  })

  it('800 元白名单收款人：verdict allow、生效级别黄（T-TOOLS-002 的试算面）', async () => {
    const h = createBankHarness()
    const result = (await h.call('transfer_preview', {
      amount: 800,
      payee: { name: '王建国', phone: '13900002222' },
      remark: '房租',
    })) as TransferPreviewResult

    expect(result.amountCents).toBe(80_000)
    expect(result.payeeBinding).toBe('whitelist')
    expect(result.effectiveTier).toBe('yellow')
    expect(result.remainingCents).toBe(100_000)
    expect(h.auditsOf('transfer/preview')).toHaveLength(1)
    expect(h.tools.get('transfer_preview')?.presentResult?.({}, result)).toMatchObject({
      kind: 'bank.transfer-preview',
    })
  })

  it('新收款人 100 元也升红（T-TOOLS-004 的试算面）', async () => {
    const h = createBankHarness()
    const result = (await h.call('transfer_preview', {
      amount: 100,
      payee: { name: '韩梅梅' },
    })) as TransferPreviewResult
    expect(result.payeeBinding).toBe('new')
    expect(result.verdict).toBe('warn')
    expect(result.effectiveTier).toBe('red')
  })

  it('金额非法 / 收款人缺失：tool-args-invalid', async () => {
    const h = createBankHarness()
    expect((await captureRejection(() => h.call('transfer_preview', { amount: 0, payee: { name: 'x' } }))).code).toBe(
      'tool-args-invalid',
    )
    expect((await captureRejection(() => h.call('transfer_preview', { amount: 100 }))).code).toBe(
      'tool-args-invalid',
    )
  })

  it('金额超出可精确表示范围：归一为 tool-args-invalid（不把账本 money-invalid 漏给模型）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() =>
      h.call('transfer_preview', {
        amount: Number.MAX_SAFE_INTEGER,
        payee: { name: '王建国', phone: '13900002222' },
      }),
    )
    expect(error.code).toBe('tool-args-invalid')
  })
})

describe('transfer_create（票据桥接）', () => {
  const ARGS = { amount: 800, payee: { name: '王建国', phone: '13900002222' }, remark: '房租' }

  it('没有票据：ticket-missing（写操作必须先过审批）', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() => h.call('transfer_create', ARGS, 'c-no-ticket'))
    expect(error.code).toBe('ticket-missing')
  })

  it('已批准票据：扣款、流水落账、票据核销', async () => {
    const h = createBankHarness()
    approveTicket(h, 'c-transfer', ARGS, 80_000)

    const result = (await h.call('transfer_create', ARGS, 'c-transfer')) as TransferCreatedResult
    expect(result.amountCents).toBe(80_000)
    expect(result.payeeName).toBe('王建国')
    expect(result.balanceCents).toBe(1_234_567 - 80_000)
    expect(result.ticketId).toBe('ticket:c-transfer')
    expect(h.core.tickets.status('ticket:c-transfer' as TicketId)).toBe('redeemed')
    expect(h.auditsOf('transfer/created')[0]?.result.txnId).toBe(result.txnId)
    expect(h.tools.get('transfer_create')?.presentResult?.({}, result)).toMatchObject({
      kind: 'bank.transfer-created',
    })
  })

  it('T9 指定正常卡：卡支付通道成功', async () => {
    const h = createBankHarness()
    const args = { ...ARGS, viaCardId: 'c-1' }
    approveTicket(h, 'c-card', args, 80_000)

    const result = (await h.call('transfer_create', args, 'c-card')) as TransferCreatedResult
    expect(result.amountCents).toBe(80_000)
    expect((await h.core.listCards(bankIds.user('u-1')))[0]?.status).toBe('normal')
  })

  it('月限额：preview 与 create 对同一笔给出同一结论（边界通过 / +1 分拒绝）', async () => {
    const h = createBankHarness()
    // 虚拟卡 c-2 月限 8,000 元：本笔正好花满
    const full = { amount: 8_000, payee: { name: '王建国', phone: '13900002222' }, viaCardId: 'c-2' }
    const boundary = (await h.call('transfer_preview', full)) as TransferPreviewResult
    expect(boundary.risks.some((risk) => risk.code === 'card-monthly-limit-exceeded')).toBe(false)
    approveTicket(h, 'c-monthly-ok', full, 800_000)
    await h.call('transfer_create', full, 'c-monthly-ok')

    const over = { ...full, amount: 0.01 }
    const preview = (await h.call('transfer_preview', over)) as TransferPreviewResult
    expect(preview.verdict).toBe('block')
    expect(preview.risks).toContainEqual(
      expect.objectContaining({ severity: 'block', code: 'card-monthly-limit-exceeded' }),
    )
    approveTicket(h, 'c-monthly-over', over, 1)
    const error = await captureRejection(() => h.call('transfer_create', over, 'c-monthly-over'))
    expect(error.code).toBe('card-monthly-limit-exceeded')
  })

  it('审批后改金额：票据绑定不一致，拒绝执行且不扣款', async () => {
    const h = createBankHarness()
    approveTicket(h, 'c-tamper', ARGS, 80_000)
    const tampered = { ...ARGS, amount: 900 }
    const error = await captureRejection(() => h.call('transfer_create', tampered, 'c-tamper'))
    expect(error.code).toBe('ticket-binding-mismatch')

    const accounts = await h.core.listAccounts(bankIds.user('u-1'))
    expect(accounts[0]?.balanceCents).toBe(1_234_567)
  })

  it('定时转账（P1）：unsupported-schedule', async () => {
    const h = createBankHarness()
    const error = await captureRejection(() =>
      h.call('transfer_create', { ...ARGS, when: '2030-01-01T00:00:00Z' }, 'c-when'),
    )
    expect(error.code).toBe('unsupported-schedule')
  })

  it('presentCall 是纯函数：同参数两次输出全等', () => {
    const h = createBankHarness()
    const tool = h.tools.get('transfer_create')!
    const first = tool.presentCall?.(ARGS)
    const second = tool.presentCall?.(ARGS)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ kind: 'bank.transfer-confirm' })
  })
})
