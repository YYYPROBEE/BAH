/**
 * 「收款进度」块：从 `aa/created` + 逐条 `aa/collected` 派生，挂到 `aa_create` 卡片上。
 *
 * 这一组守四件事：
 * 1. **只认事件**：进度靠回放累加，不从正文里抠数字；
 * 2. **幂等**：同一位参与人重复代收（或事件重放）不重复累加，也不超总额；
 * 3. **不串组**：组号对不上的入账一律丢掉，旧快照原样保留；
 * 4. **一次代收一张卡，每张是当时的快照**——演示时要能看出"钱一笔笔到账"。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import {
  aaBlockOf,
  AA_MAX_ROWS,
  aaFromResult,
  applyCollected,
  applyParticipantUpdated,
} from './aa.ts'
import { buildCard } from './cards.ts'
import { WebProjector } from './project.ts'

import type { ToolFrame } from './frames.ts'

const T0 = 1_700_000_000_000

/** 造一个 `AaGroupResult`（与 `@bah/bank` 的 dto 同形）。 */
function groupResult(paidIndexes: readonly number[] = []): Record<string, unknown> {
  const names = ['张三', '李四', '王五']
  return {
    result: {
      groupId: 'aa-group-1',
      title: '部门团建',
      totalCents: 30_000,
      collectedCents: paidIndexes.length * 10_000,
      pendingCents: 30_000 - paidIndexes.length * 10_000,
      status: paidIndexes.length === names.length ? 'completed' : 'collecting',
      createdAt: T0,
      participants: names.map((name, index) => ({
        name,
        shareCents: 10_000,
        status: paidIndexes.includes(index) ? 'paid' : 'pending',
      })),
    },
  }
}

function collected(index: number, groupId = 'aa-group-1'): Record<string, unknown> {
  return { groupId, participantIndex: index, collectedCents: 10_000, txnId: `txn-${String(index)}`, at: T0 }
}

describe('aaFromResult', () => {
  it('组快照 → 进度（顺序以参与人落账顺序为准）', () => {
    const progress = aaFromResult(groupResult([0]))
    expect(progress).toBeDefined()
    expect(progress?.groupId).toBe('aa-group-1')
    expect(progress?.participants.map((item) => item.paid)).toEqual([true, false, false])
    expect(progress?.pendingCents).toBe(20_000)
  })

  it('形态不对就返回 undefined（宁可不显示，也不显示半张表）', () => {
    expect(aaFromResult(undefined)).toBeUndefined()
    expect(aaFromResult({})).toBeUndefined()
    expect(aaFromResult({ result: { groupId: 'g' } })).toBeUndefined()
    const empty = groupResult().result as Record<string, unknown>
    expect(aaFromResult({ result: { ...empty, participants: [] } })).toBeUndefined()
  })

  it('参与者缺名字或缺份额的条目不进表', () => {
    const base = groupResult().result as Record<string, unknown>
    const broken = {
      result: {
        ...base,
        participants: [{ name: '张三', shareCents: 10_000, status: 'paid' }, { shareCents: 5000 }, { name: '' }],
      },
    }
    const progress = aaFromResult(broken)
    expect(progress?.participants).toHaveLength(1)
  })
})

describe('applyCollected', () => {
  it('推进一位：已收 +1，待收 -份额', () => {
    const before = aaFromResult(groupResult())
    const after = applyCollected(before, collected(1))
    expect(after?.participants.map((item) => item.paid)).toEqual([false, true, false])
    expect(after?.collectedCents).toBe(10_000)
    expect(after?.pendingCents).toBe(20_000)
  })

  it('幂等：同一位重复代收不重复累加', () => {
    const once = applyCollected(aaFromResult(groupResult([0])), collected(0))
    expect(once).toBeUndefined()
  })

  it('不串组：组号对不上就丢掉（旧快照不改）', () => {
    const before = aaFromResult(groupResult())
    expect(applyCollected(before, collected(1, 'aa-other'))).toBeUndefined()
  })

  it('不超收：累加夹在总额以内', () => {
    const before = aaFromResult(groupResult())
    const greed = { ...collected(2), collectedCents: 999_999 }
    const after = applyCollected(before, greed)
    expect(after?.collectedCents).toBe(30_000)
    expect(after?.pendingCents).toBe(0)
  })

  it('没有基线快照时返回 undefined（不凭一条增量凭空造组）', () => {
    expect(applyCollected(undefined, collected(0))).toBeUndefined()
  })
})

describe('aaBlockOf', () => {
  it('未收齐：摘要报已收人数与待收金额，表里一人一行', () => {
    const block = aaBlockOf(aaFromResult(groupResult([0]))!)
    expect(block.summary).toBe('已收 1/3 · 待收 ¥200.00')
    expect(block.headers).toEqual(['参与人', '份额', '状态'])
    expect(block.rows).toEqual([
      ['张三', '¥100.00', '已收'],
      ['李四', '¥100.00', '待收'],
      ['王五', '¥100.00', '待收'],
    ])
    expect(block.note).toBe('总额 ¥300.00 · 3 人')
  })

  it('已收齐：摘要只说收齐，不再报"待收 ¥0.00"', () => {
    const block = aaBlockOf(aaFromResult(groupResult([0, 1, 2]))!)
    expect(block.summary).toBe('已收齐 3/3')
    expect(block.rows.every((row) => row[2] === '已收')).toBe(true)
  })

  it('人多时只列前 N 位并如实报断点', () => {
    const many = {
      result: {
        ...(groupResult().result as object),
        totalCents: 12_000,
        pendingCents: 12_000,
        collectedCents: 0,
        participants: Array.from({ length: AA_MAX_ROWS + 2 }, (_, index) => ({
          name: `参与人${String(index)}`,
          shareCents: 1000,
          status: 'pending',
        })),
      },
    }
    const block = aaBlockOf(aaFromResult(many)!)
    expect(block.rows).toHaveLength(AA_MAX_ROWS)
    expect(block.note).toContain('下列前 10 人')
  })
})

describe('aa_create 卡片', () => {
  it('标题是中文、模板是台账、正文不再重复参与人清单', () => {
    const card = buildCard({
      name: 'aa_create',
      args: { action: 'collect', groupId: 'aa-group-1', participant: '李四' },
      content: [
        {
          type: 'text',
          text:
            'AA 收款「部门团建」：总额 ¥300.00，待收 ¥200.00。\n' +
            '- 张三：¥100.00（已收）\n' +
            '- 李四：¥100.00（已收）\n' +
            '- 王五：¥100.00（待收）',
        },
      ],
      isError: false,
      amountConfirmed: true,
      aa: aaFromResult(groupResult([0, 1])),
    })

    expect(card.title).toBe('AA 收款')
    expect(card.template).toBe('ledger')
    expect(card.fields.find((field) => field.label === '收款进度')?.value).toBe('已收 2/3 · 待收 ¥100.00')
    expect(card.table?.headers).toEqual(['参与人', '份额', '状态'])
    expect(card.table?.rows).toHaveLength(3)
    // 头行保留，参与人清单行去掉（表格已经有了）
    expect(card.body).toBe('AA 收款「部门团建」：总额 ¥300.00，待收 ¥200.00。')
  })

  it('没有进度数据时退回旧行为（不凭空造表）', () => {
    const card = buildCard({
      name: 'aa_create',
      args: { totalYuan: 300 },
      content: [{ type: 'text', text: 'AA 收款「团建」：总额 ¥300.00，待收 ¥300.00。' }],
      isError: false,
      amountConfirmed: true,
    })
    expect(card.table).toBeUndefined()
    expect(card.title).toBe('AA 收款')
  })
})

describe('投影器端到端：一次代收一张卡', () => {
  let cursor = 0
  function ev(type: string, data: unknown, at = T0): AnySessionEvent {
    cursor += 1
    return { seq: cursor, at, formatVersion: 1, type, data } as unknown as AnySessionEvent
  }

  it('第二张卡的表里两人已收（进度随事件推进）', () => {
    cursor = 0
    const projector = new WebProjector()

    // 建组
    projector.apply(ev('aa/created', groupResult()))
    projector.apply(
      ev('tool/call', {
        callId: 'call-create',
        name: 'aa_create',
        args: { action: 'create', totalYuan: 300 },
        fingerprint: 'fp-aa',
        tier: { level: 'yellow', amountPath: 'totalYuan' },
        at: T0,
      }),
    )
    projector.apply(
      ev('tool/result', {
        callId: 'call-create',
        name: 'aa_create',
        isError: false,
        content: [{ type: 'text', text: 'AA 收款「部门团建」：总额 ¥300.00，待收 ¥300.00。' }],
        durationMs: 5,
      }),
    )

    // 第一位代收
    projector.apply(ev('aa/collected', collected(0)))
    projector.apply(
      ev('tool/call', {
        callId: 'call-collect-1',
        name: 'aa_create',
        args: { action: 'collect', groupId: 'aa-group-1', participant: '张三' },
        fingerprint: 'fp-aa-1',
        tier: { level: 'yellow', amountPath: 'totalYuan' },
        at: T0,
      }),
    )
    projector.apply(
      ev('tool/result', {
        callId: 'call-collect-1',
        name: 'aa_create',
        isError: false,
        content: [{ type: 'text', text: 'AA 收款「部门团建」：总额 ¥300.00，待收 ¥200.00。\n- 张三：¥100.00（已收）' }],
        durationMs: 5,
      }),
    )

    // 第二位代收
    projector.apply(ev('aa/collected', collected(1)))
    projector.apply(
      ev('tool/call', {
        callId: 'call-collect-2',
        name: 'aa_create',
        args: { action: 'collect', groupId: 'aa-group-1', participant: '李四' },
        fingerprint: 'fp-aa-2',
        tier: { level: 'yellow', amountPath: 'totalYuan' },
        at: T0,
      }),
    )
    const frames = projector.apply(
      ev('tool/result', {
        callId: 'call-collect-2',
        name: 'aa_create',
        isError: false,
        content: [{ type: 'text', text: 'AA 收款「部门团建」：总额 ¥300.00，待收 ¥100.00。\n- 李四：¥100.00（已收）' }],
        durationMs: 5,
      }),
    )

    const card = (frames.find((frame) => frame.kind === 'tool') as ToolFrame | undefined)?.card
    expect(card?.title).toBe('AA 收款')
    expect(card?.fields.find((field) => field.label === '收款进度')?.value).toBe('已收 2/3 · 待收 ¥100.00')
    expect(card?.table?.rows.filter((row) => row[2] === '已收')).toHaveLength(2)
  })
})

describe('ADR-0017：拒绝 / 过期在进度表上不能显示成"待收"', () => {
  function updated(index: number, to: 'declined' | 'expired', groupId = 'aa-group-1'): Record<string, unknown> {
    return { groupId, participantIndex: index, from: 'pending', to, at: T0 }
  }

  it('applyParticipantUpdated：状态推进、待收减少、已收不变', () => {
    const before = aaFromResult(groupResult([0]))
    const after = applyParticipantUpdated(before, updated(1, 'declined'))
    expect(after?.participants.map((item) => item.status)).toEqual(['paid', 'declined', 'pending'])
    expect(after?.collectedCents).toBe(10_000)
    expect(after?.pendingCents).toBe(10_000)
  })

  it('幂等与防串组：非 pending、组号不符、非法 to 一律返回 undefined', () => {
    const before = aaFromResult(groupResult([0]))
    expect(applyParticipantUpdated(before, updated(0, 'declined'))).toBeUndefined()
    expect(applyParticipantUpdated(before, updated(1, 'declined', 'aa-other'))).toBeUndefined()
    expect(applyParticipantUpdated(before, updated(1, 'pending' as 'declined'))).toBeUndefined()
    expect(applyParticipantUpdated(undefined, updated(1, 'declined'))).toBeUndefined()
  })

  it('表格按状态写中文；摘要说明未参与人数', () => {
    const before = aaFromResult(groupResult([0]))
    const after = applyParticipantUpdated(before, updated(1, 'expired'))!
    const block = aaBlockOf(after)
    expect(block.rows.map((row) => row[2])).toEqual(['已收', '已过期', '待收'])
    expect(block.summary).toBe('已收 1/3 · 待收 ¥100.00 · 1 人已拒绝/过期')
  })

  it('全员收口且无 paid：摘要说"已结束"，不再报待收', () => {
    let progress = aaFromResult(groupResult())!
    progress = applyParticipantUpdated(progress, updated(0, 'declined'))!
    progress = applyParticipantUpdated(progress, updated(1, 'expired'))!
    progress = applyParticipantUpdated(progress, updated(2, 'declined'))!
    const block = aaBlockOf(progress)
    expect(block.summary).toBe('已结束：已收 0/3 · 未收 3 人')
    expect(block.rows.map((row) => row[2])).toEqual(['已拒绝', '已过期', '已拒绝'])
  })

  it('投影器：拒付事件后，卡片表与摘要同步推进', () => {
    let cursor = 0
    function ev(type: string, data: unknown): AnySessionEvent {
      cursor += 1
      return { seq: cursor, at: T0, formatVersion: 1, type, data } as unknown as AnySessionEvent
    }
    const projector = new WebProjector()
    projector.apply(ev('aa/created', groupResult()))
    projector.apply(
      ev('tool/call', {
        callId: 'call-create',
        name: 'aa_create',
        args: { action: 'create', totalYuan: 300 },
        fingerprint: 'fp-aa',
        tier: { level: 'yellow', amountPath: 'totalYuan' },
        at: T0,
      }),
    )
    projector.apply(
      ev('tool/result', {
        callId: 'call-create',
        name: 'aa_create',
        isError: false,
        content: [{ type: 'text', text: 'AA 收款「部门团建」：总额 ¥300.00，待收 ¥300.00。' }],
        durationMs: 5,
      }),
    )
    projector.apply(ev('aa/participant-updated', updated(1, 'declined')))
    projector.apply(
      ev('tool/call', {
        callId: 'call-decline',
        name: 'aa_create',
        args: { action: 'decline', groupId: 'aa-group-1', participant: '李四' },
        fingerprint: 'fp-aa-decline',
        tier: { level: 'yellow' },
        at: T0,
      }),
    )
    const frames = projector.apply(
      ev('tool/result', {
        callId: 'call-decline',
        name: 'aa_create',
        isError: false,
        content: [{ type: 'text', text: 'AA 收款「部门团建」：总额 ¥300.00，待收 ¥200.00。' }],
        durationMs: 5,
      }),
    )
    const card = (frames.find((frame) => frame.kind === 'tool') as ToolFrame | undefined)?.card
    expect(card?.fields.find((field) => field.label === '收款进度')?.value).toBe(
      '已收 0/3 · 待收 ¥200.00 · 1 人已拒绝/过期',
    )
    expect(card?.table?.rows.map((row) => row[2])).toEqual(['待收', '已拒绝', '待收'])
  })
})
