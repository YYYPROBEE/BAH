/**
 * TC-W03-06：两个资产处置工具的档位必须"声明即执行"。
 *
 * 只钉声明面不够（`specOf().tier` 只是元数据）：真正要证明的是
 * **红档真的会带上强验证挑战、黄档真的只问一次**，且两者都落各自领域事件。
 */

import { describe, expect, it } from 'vitest'

import { bankIds } from '../core/index.ts'
import type { AccountsResult } from './dto.ts'
import { specOf } from './specs.ts'
import { createPipelineHarness, TEST_CONFIG } from './testing.ts'

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
