/**
 * 审批审计联接（租户与鉴权 03 · TA-46）：链行 → "票据 → 结论 → 操作者"。
 *
 * 这里钉的是**审计取证的不变量**，不是覆盖率数字：
 * - 后到的 actor 不能给已有结论"追认"一个主人（伪造面）；
 * - 结论前没有 actor 的放行必须落告警（人批必有主）；
 * - 畸形信封（空 ticketId / 非 principal 主体）跳过并告警，不能静默错配。
 */

import { describe, expect, it } from 'vitest'

import { joinApprovalActors } from './audit-approvals.ts'

import type { ChainRecord } from '@bah/persistence'

const BASE: Omit<ChainRecord, 'q' | 't' | 'sub'> = {
  s: 'saga-1',
  hb: [],
  d: 'digest',
  p: 'prev',
  r: 'record',
  keyVersion: 1,
  recordedAt: 1_000,
}

function row(overrides: Pick<ChainRecord, 'q' | 't' | 'sub'> & Partial<ChainRecord>): ChainRecord {
  return { ...BASE, ...overrides }
}

function actor(q: number, ticketId: string, subject: string, recordedAt = 1_000): ChainRecord {
  return row({ q, t: 'approval/actor', sub: ticketId, subject, recordedAt })
}

function decided(q: number, ticketId: string, decision?: ChainRecord['decision'], recordedAt = 2_000): ChainRecord {
  return row({ q, t: 'approval/decided', sub: ticketId, decision, recordedAt })
}

describe('joinApprovalActors · 正常联接', () => {
  it('前置 actor + 放行结论 → 同一票据行带操作者，machine=false', () => {
    const join = joinApprovalActors([
      actor(1, 't-1', 'principal:demo/u-1', 10),
      decided(2, 't-1', 'allow', 20),
    ])

    expect(join.warnings).toEqual([])
    expect(join.rows).toEqual([
      {
        ticketId: 't-1',
        decision: 'allow',
        actor: { ticketId: 't-1', userId: 'u-1', tenantId: 'demo', at: 10 },
        at: 20,
        machine: false,
      },
    ])
  })

  it('没有 actor 的结论按 machine 处理；只有 allow 落"人批必有主"告警', () => {
    const join = joinApprovalActors([
      decided(1, 't-2', 'allow', 20),
      decided(2, 't-3', 'deny', 30),
    ])

    expect(join.rows).toEqual([
      { ticketId: 't-2', decision: 'allow', at: 20, machine: true },
      { ticketId: 't-3', decision: 'deny', at: 30, machine: true },
    ])
    expect(join.warnings).toHaveLength(1)
    expect(join.warnings[0]).toContain('人批必有主')
    expect(join.warnings[0]).toContain('t-2')
    expect(join.warnings[0]).not.toContain('t-3')
  })

  it('结论之后到达的 actor 不改写已落结论的操作者（不能事后追认）', () => {
    const join = joinApprovalActors([
      actor(1, 't-4', 'principal:demo/u-1', 10),
      decided(2, 't-4', 'deny', 20),
      actor(3, 't-4', 'principal:demo/u-2', 30),
    ])

    const [row] = join.rows
    expect(row?.actor?.userId).toBe('u-1')
    expect(row?.machine).toBe(false)
    expect(join.warnings).toEqual([])
  })

  it('结论前的重复 actor：以最后一次为准，结论仍挂在该操作者上', () => {
    const join = joinApprovalActors([
      actor(1, 't-5', 'principal:demo/u-1', 10),
      actor(2, 't-5', 'principal:demo/u-2', 20),
      decided(3, 't-5', 'allow', 30),
    ])

    const [row] = join.rows
    expect(row?.actor?.userId).toBe('u-2')
    expect(row?.actor?.at).toBe(20)
    expect(row?.machine).toBe(false)
  })
})

describe('joinApprovalActors · 畸形链行', () => {
  it('空 ticketId（sub 为空）→ 两类条目都跳过并各告警一行', () => {
    const join = joinApprovalActors([
      actor(1, '', 'principal:demo/u-1'),
      decided(2, '', 'deny'),
    ])

    expect(join.rows).toEqual([])
    expect(join.warnings).toHaveLength(2)
    expect(join.warnings[0]).toContain('saga-1#1')
    expect(join.warnings[0]).toContain('缺 ticketId')
    expect(join.warnings[1]).toContain('saga-1#2')
    expect(join.warnings[1]).toContain('缺 ticketId')
  })

  it('actor 的 subject 不是 principal 信封 → 跳过并告警，后续 allow 仍按 machine 处理', () => {
    const join = joinApprovalActors([
      actor(1, 't-6', 'svc:web'),
      decided(2, 't-6', 'allow', 20),
    ])

    expect(join.rows).toEqual([{ ticketId: 't-6', decision: 'allow', at: 20, machine: true }])
    expect(join.warnings).toHaveLength(2)
    expect(join.warnings[0]).toContain('不是 principal:<tenant>/<user>')
    expect(join.warnings[1]).toContain('人批必有主')
  })

  it('principal 缺租户或缺用户 → 都视为非法主体', () => {
    const join = joinApprovalActors([
      actor(1, 't-7', 'principal:/u-1'),
      actor(2, 't-8', 'principal:demo/'),
    ])

    expect(join.rows).toEqual([])
    expect(join.warnings).toHaveLength(2)
    for (const warning of join.warnings) expect(warning).toContain('不是 principal:<tenant>/<user>')
  })

  it('非审批条目忽略；缺失/非字符串 decision 记为 unknown', () => {
    const join = joinApprovalActors([
      row({ q: 1, t: 'tool/call', sub: 't-9' }),
      decided(2, 't-9', undefined, 20),
    ])

    expect(join.rows).toEqual([{ ticketId: 't-9', decision: 'unknown', at: 20, machine: true }])
    expect(join.warnings).toEqual([])
  })
})
