/**
 * M2 规则抽取（T2.1–T2.5、T2.9）。
 *
 * 抽取器是"禁 LLM"的纯函数，所以这里全部是不起数据库的裸调用——测试跑得快，
 * 而且失败时能立刻分清"抽取错了"还是"存储错了"。
 */

import { describe, expect, it } from 'vitest'

import { extractCandidates } from './extract/rules.ts'
import { createMemoryLayer } from './layer.ts'

import type { IngestInput } from './types.ts'
import type { MemoryLayer } from './layer.ts'

const FIXED_NOW = Date.parse('2026-10-22T10:00:00.000Z')
const TENANT = 't-bank'
const USER = 'u-001'

function input(text: string, overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    tenant: TENANT,
    user_id: USER,
    session_id: 's-1',
    turn_id: 1,
    scene: 'transfer',
    speaker: 'user',
    text,
    ...overrides,
  }
}

describe('M2 · 抽取', () => {
  it('T2.1 P1 抽取：SPO / scene / object 全对', () => {
    const result = extractCandidates(input('以后转账都用尾号8888的卡'))
    expect(result.memories).toHaveLength(1)
    const candidate = result.memories[0]
    expect(candidate?.subject).toBe('user')
    expect(candidate?.predicate).toBe('preferred_card_for')
    expect(candidate?.object).toEqual({ card_last4: '8888' })
    expect(candidate?.scene).toBe('transfer')
    expect(candidate?.pattern).toBe('P1')
  })

  it('T2.1b P1 带收款人：走 preferred_payee_card 且主体是 payee', () => {
    const result = extractCandidates(input('以后给房东转账用尾号8888卡'))
    const candidate = result.memories[0]
    expect(candidate?.predicate).toBe('preferred_payee_card')
    expect(candidate?.subject).toBe('payee:房东')
  })

  it('T2.2 P2 抽取：alias_of 正确', () => {
    const result = extractCandidates(input('工资卡是尾号6666', { scene: 'card' }))
    const candidate = result.memories[0]
    expect(candidate?.predicate).toBe('alias_of')
    expect(candidate?.subject).toBe('alias:工资卡')
    expect(candidate?.object).toEqual({ card_last4: '6666' })
  })

  it('T2.3 P3 指代解析：recentEntities 解析出 card:8888', () => {
    const result = extractCandidates(
      input('我的卡丢了', { scene: 'card', recentEntities: ['payee:房东', 'card:8888'] }),
    )
    const candidate = result.memories[0]
    expect(candidate?.subject).toBe('card:8888')
    expect(candidate?.predicate).toBe('card_state')
    expect(candidate?.object).toEqual({ status: 'lost' })
  })

  it('T2.3b P3 显式尾号优先于 recentEntities', () => {
    const result = extractCandidates(
      input('我的尾号6666的卡挂失了', { scene: 'card', recentEntities: ['card:8888'] }),
    )
    expect(result.memories[0]?.subject).toBe('card:6666')
    expect(result.memories[0]?.object).toEqual({ status: 'frozen_by_user' })
  })

  it('T2.4 P3 主体未解析：EXTRACT_SUBJECT_UNRESOLVED + 反问建议', async () => {
    const extracted = extractCandidates(input('我的卡注销了', { scene: 'card' }))
    expect(extracted.memories).toHaveLength(0)
    expect(extracted.unresolved[0]?.family).toBe('card')
    expect(extracted.unresolved[0]?.suggestion).toContain('尾号后四位')

    const layer: MemoryLayer = createMemoryLayer({ dbPath: ':memory:', now: () => FIXED_NOW })
    const result = await layer.ingestTurn(input('我的卡注销了', { scene: 'card' }))
    expect(result.written).toBe(0)
    expect(result.rejected.map((item) => item.code)).toContain('EXTRACT_SUBJECT_UNRESOLVED')
    layer.close()
  })

  it('T2.5 非显式不抽取：闲聊产出 0 候选（FM-6）', () => {
    const result = extractCandidates(input('我想看看这个月的账单'))
    expect(result.memories).toHaveLength(0)
    expect(result.vaults).toHaveLength(0)
    expect(result.unresolved).toHaveLength(0)
  })

  it('T2.9 PII 脱敏：完整卡号不落库，object 只留尾 4（FM-5）', async () => {
    const layer = createMemoryLayer({ dbPath: ':memory:', now: () => FIXED_NOW })
    const result = await layer.ingestTurn(input('工资卡是6222021234568888的卡', { scene: 'card' }))
    expect(result.written).toBe(1)

    const row = layer.store.listUnits(TENANT, USER)[0]
    expect(row?.object).toEqual({ card_last4: '8888' })
    // 关键断言：完整卡号一个字都不能进 object。
    expect(JSON.stringify(row?.object)).not.toContain('6222021234568888')
    layer.close()
  })
})
