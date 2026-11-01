/**
 * 审计时间线里的知识平面行（`knowledge/*` 域事件）。
 *
 * `auditOf` 的分类分支中，只有这一条此前从未被执行过（其余审批 / 票据 / 工具 /
 * 安全 / 订阅 / 轮次都在 `audit.test.ts` 里有样例）。它值得单独钉，是因为
 * 知识平面的判决正是"能不能看这块数据"的结论：ACL 拒绝与降级必须在时间线上
 * 留下可读的一行，否则对外说明现场问"客户凭什么拿到这份答案"时，唯一证据源是空的。
 *
 * 口径照 `audit.ts` 头部：**只挑有判决含义的事件**，字段缺失就少写一段，
 * 绝不因为载荷形状不对而抛错（时间线坏了不能拖垮对话）。
 */

import { describe, expect, it } from 'vitest'

import { auditOf } from './audit.ts'

/** 造一条域事件（`appendDomain` 出来的就是这种裸形状）。 */
function ev(seq: number, type: string, data: unknown, at = 1_700_000_000_000) {
  return { seq, at, type, data }
}

describe('auditOf · knowledge/*', () => {
  it('knowledge/answered：verdict 与理由码都进时间线（拒绝可追责）', () => {
    const frame = auditOf(
      ev(7, 'knowledge/answered', {
        traceId: 'tr-1',
        kind: 'refusal',
        verdict: 'acl-denied',
        reasonCode: 'SCOPE_EMPTY',
        citationCount: 0,
        answerChars: 12,
        at: 1_700_000_000_000,
      }),
    )

    expect(frame).toMatchObject({
      kind: 'audit',
      category: 'knowledge',
      label: '知识平面',
      summary: 'knowledge/answered · acl-denied',
      code: 'SCOPE_EMPTY',
    })
    expect(frame?.timeText).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('knowledge/queried：没有理由码时不写 code（历史行不补空字段）', () => {
    const frame = auditOf(
      ev(8, 'knowledge/queried', {
        traceId: 'tr-2',
        kind: 'evidence',
        visibleCount: 3,
        verdict: 'ok',
        reasonCode: null,
        citationCount: 2,
        at: 1_700_000_001_000,
      }),
    )

    expect(frame?.category).toBe('knowledge')
    expect(frame?.summary).toBe('knowledge/queried · ok')
    expect(frame && 'code' in frame).toBe(false)
  })

  it('verdict 缺失 / 不是字符串 ⇒ unknown（判决缺失要显式承认，不能整行丢掉）', () => {
    for (const data of [
      { traceId: 'tr-3', kind: 'lookup', citationCount: 0 },
      { traceId: 'tr-4', kind: 'lookup', verdict: 7, citationCount: 0 },
      { traceId: 'tr-5', kind: 'lookup', verdict: '', citationCount: 0 },
    ]) {
      const frame = auditOf(ev(9, 'knowledge/answered', data))
      expect(frame?.summary, JSON.stringify(data)).toBe('knowledge/answered · unknown')
      expect(frame?.category).toBe('knowledge')
    }
  })

  it('载荷不是对象 ⇒ 仍产一行 unknown，且不抛（时间线不能拖垮对话）', () => {
    for (const data of [null, 'nope', []]) {
      const frame = auditOf(ev(10, 'knowledge/queried', data))
      expect(frame?.summary, String(data)).toBe('knowledge/queried · unknown')
    }
  })

  it('非知识域且未登记的事件 ⇒ 不进时间线（不产"知识平面"假行）', () => {
    expect(auditOf(ev(11, 'user/message', { content: '查余额' }))).toBeUndefined()
    expect(auditOf(ev(12, 'knowledgez/oops', { verdict: 'ok' }))).toBeUndefined()
  })
})
