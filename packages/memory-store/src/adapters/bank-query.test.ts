/**
 * `@bah/bank` 适配层。
 *
 * 这一组测试同时在固定一件事：**"接口未实现"与"实体不存在"必须可区分**。
 * 若两者混为一谈，M3 的影子核验会把"银行侧还没做卡查询"渲染成"这张卡已注销"，
 * D1 的演示就变成了假证据。
 */

import { describe, expect, it } from 'vitest'

import { createBankQuery } from './bank-query.ts'

const USER = 'u-001'
const NOW = Date.parse('2026-10-22T10:00:00.000Z')

const provider = {
  async listAccounts(userId: string) {
    if (userId !== USER) return []
    return [{ id: 'acc-1', status: 'normal' }]
  },
  async balance(accountId: string) {
    if (accountId !== 'acc-1') throw new Error('account-not-found')
    return { asOf: NOW }
  },
}

describe('bank-query 适配器', () => {
  it('账户状态真查：命中账户返回状态与 asOf', async () => {
    const query = createBankQuery(provider, { userId: USER, now: () => NOW })
    const state = await query({ kind: 'account', key: 'acc-1' })
    expect(state).toEqual({ status: 'normal', asOf: '2026-10-22T10:00:00.000Z' })
  })

  it('账户不存在：返回 null（真实"查无此实体"）', async () => {
    const query = createBankQuery(provider, { userId: USER, now: () => NOW })
    expect(await query({ kind: 'account', key: 'acc-404' })).toBeNull()
  })

  it('卡状态未注入：返回 null 且上报 unsupported，绝不伪造 normal', async () => {
    const seen: { kind: string; key: string }[] = []
    const query = createBankQuery(provider, {
      userId: USER,
      now: () => NOW,
      onUnsupported: (detail) => seen.push({ kind: detail.kind, key: detail.key }),
    })

    const state = await query({ kind: 'card', key: '8888' })
    expect(state).toBeNull()
    expect(seen).toEqual([{ kind: 'card', key: '8888' }])
  })

  it('卡状态注入后走真实查询', async () => {
    const query = createBankQuery(provider, {
      userId: USER,
      now: () => NOW,
      cardStatus: async (tail4) => (tail4 === '8888' ? 'lost' : null),
    })
    expect(await query({ kind: 'card', key: '8888' })).toEqual({
      status: 'lost',
      asOf: '2026-10-22T10:00:00.000Z',
    })
    expect(await query({ kind: 'card', key: '9999' })).toBeNull()
  })

  it('订阅实体：bank core 无此能力，一律上报 unsupported', async () => {
    const seen: string[] = []
    const query = createBankQuery(provider, {
      userId: USER,
      now: () => NOW,
      onUnsupported: (detail) => seen.push(detail.kind),
    })
    expect(await query({ kind: 'subscription', key: 'netflix' })).toBeNull()
    expect(seen).toEqual(['subscription'])
  })
})
