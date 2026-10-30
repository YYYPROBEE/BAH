/**
 * TC-W03-06：两个资产处置工具的档位必须"声明即执行"。
 *
 * 只钉声明面不够（`specOf().tier` 只是元数据）：真正要证明的是
 * **红档真的会带上强验证挑战、黄档真的只问一次**，且两者都落各自领域事件。
 */

import { describe, expect, it } from 'vitest'

import { bankIds } from '../core/index.ts'
import type { AccountsResult } from './dto.ts'
import type { CardStateResult } from './account-ops.ts'
import { BANK_TOOL_NAMES, specOf, type BankToolName } from './specs.ts'
import { decide } from './tier.ts'
import { createBankHarness, createPipelineHarness, TEST_CONFIG } from './testing.ts'

/** 取某类会话事件载荷。 */
function payloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

describe('TC-W03-06 新工具的档位（声明 + 行为）', () => {
  const CONFIG = {
    dailyTransferLimitCents: TEST_CONFIG.dailyTransferLimit,
    riskyOps: TEST_CONFIG.riskyOps,
    riskyCallThreshold: TEST_CONFIG.riskyCallThreshold,
  }
  const levelOf = (name: BankToolName) =>
    decide({
      name,
      declared: specOf(name).tier.level,
      config: CONFIG,
      state: { userId: 'u-1', riskyCallsInTurn: 0, verifyLocked: false },
    })

  it('C1 挂失红 / 冻结黄 / 解冻红（同一模块跨三级）', () => {
    expect(levelOf('card_report_lost')).toMatchObject({ kind: 'ask', level: 'red', challenge: true })
    expect(levelOf('card_freeze')).toMatchObject({ kind: 'ask', level: 'yellow', challenge: false })
    expect(levelOf('card_unfreeze')).toMatchObject({ kind: 'ask', level: 'red', challenge: true })
  })

  it('C2 未绑定身份：卡片写操作一律 deny no-identity', () => {
    const verdict = decide({
      name: 'card_freeze',
      declared: specOf('card_freeze').tier.level,
      config: CONFIG,
      state: { userId: undefined, riskyCallsInTurn: 0, verifyLocked: false },
    })
    expect(verdict).toMatchObject({ kind: 'deny', code: 'no-identity' })
  })

  it('C3 冻结后用该卡转账：预检 block，治理面据此拒', async () => {
    const h = createBankHarness()
    await h.call('card_freeze', { cardId: 'c-1' })
    const preview = await h.core.previewTransfer({
      fromAccountId: bankIds.account('a-1'),
      payee: { name: '王建国' },
      amountCents: 10_000,
      channel: 'app',
      viaCardId: bankIds.card('c-1'),
    })
    expect(preview.risks.find((risk) => risk.code === 'card-unavailable')?.severity).toBe('block')
    expect(preview.verdict).toBe('block')
  })

  it('C4 批量停卡：没有批量工具，两张卡必须两次调用', async () => {
    expect(BANK_TOOL_NAMES.some((name) => name.includes('batch'))).toBe(false)
    const h = createBankHarness()
    await h.call('card_freeze', { cardId: 'c-1' })
    await h.call('card_freeze', { cardId: 'c-2' })
    expect(h.auditsOf('card/state-changed')).toHaveLength(2)
  })

  it('先 account_list 取 cardId，再挂失（端到端可达）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const listed = await h.run('account_list', {})
      expect(listed.result.isError).toBe(false)

      const target = (listed.value as AccountsResult).cards.find((card) => card.tail === '1234')
      expect(target).toBeDefined()

      const execution = await h.run('card_report_lost', { cardId: target!.cardId })
      expect(execution.result.isError).toBe(false)
      expect(h.audits.find((record) => record.type === 'card/reported-lost')?.data).toMatchObject(
        { cardId: target!.cardId, status: 'lost' },
      )
    } finally {
      await h.dispose()
    }
  })

  it('声明面：card_report_lost 红档 / sub_cancel 黄档，且都不带 amountPath', () => {
    expect(specOf('card_report_lost').tier).toEqual({ level: 'red' })
    expect(specOf('sub_cancel').tier).toEqual({ level: 'yellow' })
  })

  it('card_report_lost 走红档：审批携带强验证挑战，落 card/reported-lost', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('card_report_lost', { cardId: bankIds.card('c-1') })

      expect(execution.result.isError).toBe(false)
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        name: 'card_report_lost',
        challenge: TEST_CONFIG.redChallenge,
      })
      expect(h.audits.map((record) => record.type)).toContain('card/reported-lost')
      expect(h.audits.find((record) => record.type === 'card/reported-lost')?.data).toMatchObject({
        cardId: 'c-1',
        status: 'lost',
      })
    } finally {
      await h.dispose()
    }
  })

  it('sub_cancel 走黄档：只审批、不带强验证挑战，落 sub/cancelled', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('sub_cancel', {
        subscriptionId: bankIds.subscription('s-1'),
      })

      expect(execution.result.isError).toBe(false)
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]?.['name']).toBe('sub_cancel')
      expect(asked[0]?.['challenge']).toBeUndefined()
      expect(h.audits.map((record) => record.type)).toContain('sub/cancelled')
      expect(h.audits.find((record) => record.type === 'sub/cancelled')?.data).toMatchObject({
        subscriptionId: 's-1',
        merchant: '视频会员',
      })
    } finally {
      await h.dispose()
    }
  })

  it('T1/T2 冻结：首次发一条迁移事件，重复调用 changed=false 且不发事件', async () => {
    const h = createBankHarness()
    const first = (await h.call('card_freeze', { cardId: 'c-1', reason: '疑似盗刷' })) as CardStateResult
    const second = (await h.call('card_freeze', { cardId: 'c-1' })) as CardStateResult

    expect(first).toMatchObject({ cardId: 'c-1', tail: '1234', status: 'frozen', changed: true })
    expect(second.changed).toBe(false)
    expect(h.auditsOf('card/state-changed')).toHaveLength(1)
    expect(h.auditsOf('card/state-changed')[0]).toMatchObject({
      cardId: 'c-1',
      tail: '1234',
      from: 'normal',
      to: 'frozen',
      reason: 'freeze',
      note: '疑似盗刷',
    })
  })

  it('T4 解冻：反向迁移事件，重复调用幂等', async () => {
    const h = createBankHarness()
    await h.call('card_freeze', { cardId: 'c-1' })
    const first = (await h.call('card_unfreeze', { cardId: 'c-1' })) as CardStateResult
    const second = (await h.call('card_unfreeze', { cardId: 'c-1' })) as CardStateResult

    expect(first).toMatchObject({ status: 'normal', changed: true })
    expect(second.changed).toBe(false)
    expect(h.auditsOf('card/state-changed')).toHaveLength(2)
    expect(h.auditsOf('card/state-changed')[1]).toMatchObject({
      from: 'frozen',
      to: 'normal',
      reason: 'unfreeze',
    })
  })

  it('T8 冻结后转账：管线早拒 card-unavailable，票据不签发', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      await h.run('card_freeze', { cardId: 'c-1' })

      const execution = await h.run('transfer_create', {
        amount: 100,
        payee: { name: '王建国', phone: '13900002222' },
        viaCardId: 'c-1',
      })
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('card-unavailable')
      const asked = payloads(h, 'approval/asked').filter(
        (payload) => payload['name'] === 'transfer_create',
      )
      expect(asked).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('拒绝即不执行：红档被拒后不落 card/reported-lost', async () => {
    const h = createPipelineHarness({ approval: 'rejected' })
    try {
      const execution = await h.run('card_report_lost', { cardId: bankIds.card('c-2') })

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('approval-rejected')
      expect(h.audits.map((record) => record.type)).not.toContain('card/reported-lost')
    } finally {
      await h.dispose()
    }
  })
})
