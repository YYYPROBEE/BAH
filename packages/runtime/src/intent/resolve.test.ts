import { describe, expect, it } from 'vitest'

import { EMPTY_SLOT_TABLE, type FilledSlot, type SlotTable } from './types.ts'
import { buildProposals, resolveIntent, type ResolveContext, type ResolveInput } from './resolve.ts'
import { SCENE_HINTS } from './lexicon.ts'
import { normalizeUtteranceSlots } from './slots.ts'
import type { IntentMemoryItem, RecallSnapshot } from './recall.ts'

const TODAY = '2026-10-28'
const ctx = (scene = 'transfer'): ResolveContext => ({ scene, today: TODAY })

function slot(name: FilledSlot['name'], value: string | number, source: FilledSlot['source']): FilledSlot {
  return { name, value, source, confidence: 0.9 }
}

function table(base: Partial<SlotTable> = {}): SlotTable {
  return { ...EMPTY_SLOT_TABLE, ...base }
}

function memory(
  fields: readonly { readonly name: FilledSlot['name']; readonly value: string | number }[],
  confidence = 0.8,
  unitId = 'm1',
): IntentMemoryItem {
  return { unitId, sceneTag: 'transfer', confidence, renderedText: '历史记录', fields }
}

function snapshot(overrides: Partial<RecallSnapshot> = {}): RecallSnapshot {
  return { routeCode: 'ROUTE_OK', memories: [], crossScene: null, ...overrides }
}

function input(utterance: string, overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    utterance,
    slots: EMPTY_SLOT_TABLE,
    recall: null,
    lastTurnKind: null,
    ...overrides,
  }
}

const HISTORY: RecallSnapshot = snapshot({
  memories: [
    memory([
      { name: 'payee', value: '王建国' },
      { name: 'amountCents', value: 80000 },
    ]),
  ],
})

describe('vague（TC-INT-01～04）', () => {
  it('TC-INT-01 历史复现：vague + 取记忆值 + 强制预演', () => {
    const resolution = resolveIntent(input('上次那个转账再来一次', { recall: HISTORY }), ctx())
    expect(resolution.kind).toBe('vague')
    expect(resolution.decision).toBe('proceed')
    expect(resolution.requiresPreview).toBe(true)
    expect(resolution.filled).toContainEqual({
      name: 'amountCents',
      value: 80000,
      source: 'memory',
      confidence: 0.8,
    })
    expect(resolution.evidence.some((item) => item.ruleId === 'R-VAGUE-1')).toBe(true)
    expect(resolution.confidence).toBe(0.75)
  })

  it('无历史时仍判 vague，但只能追问（绝不瞎猜）', () => {
    const resolution = resolveIntent(input('上次那个转账再来一次'), ctx())
    expect(resolution.kind).toBe('vague')
    expect(resolution.decision).toBe('ask')
    expect(resolution.requiresPreview).toBe(true)
    expect(resolution.askHint).not.toBeNull()
  })

  it('TC-INT-02 含混词 + 缺槽 ⇒ ask，缺收款人与金额', () => {
    const resolution = resolveIntent(input('随便转点钱'), ctx())
    expect(resolution.kind).toBe('vague')
    expect(resolution.decision).toBe('ask')
    expect(resolution.missing).toEqual(['payee', 'amountCents'])
    expect(resolution.askHint?.slot).toBe('payee')
  })

  it('TC-INT-03 代词无先行词：只缺收款人，金额已填', () => {
    const resolution = resolveIntent(input('转500给他'), ctx())
    expect(resolution.kind).toBe('vague')
    expect(resolution.decision).toBe('ask')
    expect(resolution.askHint?.slot).toBe('payee')
    expect(resolution.filled).toContainEqual({
      name: 'amountCents',
      value: 50000,
      source: 'utterance',
      confidence: 0.95,
    })
  })

  it('TC-INT-04 反例：直白转账是 explicit 且不需预演', () => {
    const resolution = resolveIntent(input('给张三转500元'), ctx())
    expect(resolution.kind).toBe('explicit')
    expect(resolution.decision).toBe('proceed')
    expect(resolution.requiresPreview).toBe(false)
    expect(resolution.evidence.some((item) => item.ruleId === 'R-EXP-1')).toBe(true)
  })
})

describe('elliptical（TC-INT-05～08）', () => {
  it('TC-INT-05 短句省略：收款人继承会话层，金额仍缺 ⇒ ask', () => {
    const resolution = resolveIntent(
      input('就转给他', {
        slots: table({ session: { payee: slot('payee', '张**', 'user-choice') } }),
        lastTurnKind: 'vague',
      }),
      ctx(),
    )
    expect(resolution.kind).toBe('elliptical')
    expect(resolution.filled).toContainEqual({
      name: 'payee',
      value: '张**',
      source: 'user-choice',
      confidence: 0.9,
    })
    expect(resolution.missing).toEqual(['amountCents'])
    expect(resolution.decision).toBe('ask')
    expect(resolution.evidence.some((item) => item.ruleId === 'R-ELL-1')).toBe(true)
  })

  it('TC-INT-06 改口覆盖会话层旧值（不是冲突）', () => {
    const resolution = resolveIntent(
      input('改成800', {
        slots: table({
          session: {
            payee: slot('payee', '张三', 'session'),
            amountCents: slot('amountCents', 50000, 'session'),
          },
        }),
        lastTurnKind: 'explicit',
      }),
      ctx(),
    )
    expect(resolution.kind).toBe('elliptical')
    expect(resolution.conflicts).toEqual([])
    expect(resolution.filled).toContainEqual({
      name: 'amountCents',
      value: 80000,
      source: 'utterance',
      confidence: 0.95,
    })
    expect(resolution.evidence.some((item) => item.ruleId === 'R-ELL-1')).toBe(true)
  })

  it('TC-INT-07 反例：查询记录是 explicit，不触发复现路径', () => {
    const resolution = resolveIntent(input('查一下上次的转账记录'), ctx('bills'))
    expect(resolution.kind).toBe('explicit')
    expect(resolution.requiresPreview).toBe(false)
    expect(resolution.evidence.some((item) => item.ruleId === 'R-VAGUE-1')).toBe(false)
  })

  it('TC-INT-08 边界：纯数值但无可继承 ⇒ 不误判省略', () => {
    const resolution = resolveIntent(input('800'), ctx())
    expect(resolution.kind).toBe('explicit')
    expect(resolution.decision).toBe('ask')
    // 「800」本身已抽出金额，缺的只有收款人；设计说明的「missing 全量」按此口径理解（§9 偏差 6）
    expect(resolution.missing).toEqual(['payee'])
  })

  it('纯数值句在有上下文时写金额（R-ELL-2）', () => {
    const resolution = resolveIntent(
      input('800', {
        slots: table({ session: { payee: slot('payee', '张三', 'session') } }),
        lastTurnKind: 'explicit',
      }),
      ctx(),
    )
    expect(resolution.kind).toBe('elliptical')
    expect(resolution.filled).toContainEqual({
      name: 'amountCents',
      value: 80000,
      source: 'utterance',
      confidence: 0.95,
    })
    expect(resolution.evidence.some((item) => item.ruleId === 'R-ELL-2')).toBe(true)
  })
})

describe('implicit（TC-INT-09～12）', () => {
  it('TC-INT-09 场景陈述只出提案，不填槽位', () => {
    const resolution = resolveIntent(input('我爱人生日快到了'), ctx('unknown'))
    expect(resolution.kind).toBe('implicit')
    expect(resolution.decision).toBe('propose')
    expect(resolution.proposals).toHaveLength(1)
    expect(resolution.proposals[0]?.candidateActions).toEqual(['transfer_preview'])
    expect(resolution.proposals[0]?.ruleId).toBe('R-IMP-1')
    expect(resolution.filled).toEqual([])
    expect(resolution.askHint).toBeNull()
  })

  it('TC-INT-10 咨询式问句也是 implicit', () => {
    const resolution = resolveIntent(input('刚发工资，钱放着有点亏'), ctx('unknown'))
    expect(resolution.kind).toBe('implicit')
    expect(resolution.decision).toBe('propose')
  })

  it('咨询模板（R-IMP-2）产出理财类提案', () => {
    const resolution = resolveIntent(input('这钱怎么理财比较划算吗'), ctx('unknown'))
    expect(resolution.kind).toBe('implicit')
    expect(resolution.proposals[0]?.ruleId).toBe('R-IMP-2')
    expect(resolution.proposals[0]?.candidateActions).toContain('wealth_list')
  })

  it('TC-INT-11 反例：带动作动词时 explicit 优先于 implicit', () => {
    const resolution = resolveIntent(input('爱人生日快到了，直接给张三转520'), ctx())
    expect(resolution.kind).toBe('explicit')
    expect(resolution.filled).toContainEqual({
      name: 'amountCents',
      value: 52000,
      source: 'utterance',
      confidence: 0.95,
    })
  })

  it('TC-INT-12 属性式：场景词 × 模板全部 propose，永不 proceed', () => {
    const templates = ['{s}', '我{s}了', '{s}快到了', '最近{s}']
    for (const hint of SCENE_HINTS) {
      for (const template of templates) {
        const resolution = resolveIntent(input(template.replace('{s}', hint)), ctx('unknown'))
        expect(resolution.decision).toBe('propose')
        expect(resolution.kind).toBe('implicit')
      }
    }
  })
})

describe('ambiguous（TC-INT-13～15）', () => {
  it('TC-INT-13 双域命中 ⇒ ask，候选是两种解释', () => {
    const resolution = resolveIntent(input('把转账卡的钱还上'), ctx())
    expect(resolution.kind).toBe('ambiguous')
    expect(resolution.decision).toBe('ask')
    expect(resolution.evidence.some((item) => item.ruleId === 'R-AMB-1')).toBe(true)
    expect(resolution.askHint?.slot).toBe('targetScene')
    expect(resolution.askHint?.candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('TC-INT-14 一个名字对两个实体 ⇒ conflicts 两条候选', () => {
    const recall = snapshot({
      memories: [
        memory([{ name: 'payee', value: '张伟（同事）' }], 0.8, 'm1'),
        memory([{ name: 'payee', value: '张伟（房东）' }], 0.7, 'm2'),
      ],
    })
    const resolution = resolveIntent(input('给张伟转200', { recall }), ctx())
    expect(resolution.kind).toBe('ambiguous')
    expect(resolution.conflicts).toHaveLength(1)
    expect(resolution.conflicts[0]?.name).toBe('payee')
    expect(resolution.conflicts[0]?.candidates.map((item) => item.value)).toEqual([
      '张伟（同事）',
      '张伟（房东）',
    ])
    expect(resolution.evidence.some((item) => item.ruleId === 'R-AMB-2')).toBe(true)
  })

  it('TC-INT-15 歧义槽位不进 filled（禁止默认值填充）', () => {
    const recall = snapshot({
      memories: [
        memory([{ name: 'payee', value: '张伟（同事）' }], 0.8, 'm1'),
        memory([{ name: 'payee', value: '张伟（房东）' }], 0.7, 'm2'),
      ],
    })
    const resolution = resolveIntent(input('给张伟转200', { recall }), ctx())
    expect(resolution.filled.some((item) => item.name === 'payee')).toBe(false)
    expect(resolution.filled.some((item) => item.name === 'amountCents')).toBe(true)
  })

  it('只有一个同名实体时不算歧义（单候选直接 explicit）', () => {
    const recall = snapshot({ memories: [memory([{ name: 'payee', value: '张伟' }])] })
    const resolution = resolveIntent(input('给张伟转200', { recall }), ctx())
    expect(resolution.kind).toBe('explicit')
    expect(resolution.conflicts).toEqual([])
  })
})

describe('跨场景拒借（TC-INT-22）', () => {
  const refused = snapshot({
    routeCode: 'CROSS_SCENE_REFUSED',
    memories: [memory([{ name: 'payee', value: '王建国' }])],
    crossScene: { target: 'transfer', confidence: 0.59, allowed: false, rejectReason: 'low-confidence' },
  })

  it('拒借强制 ask 并给建议反问', () => {
    const resolution = resolveIntent(input('把那边的事接着办', { recall: refused }), ctx('cross_scene'))
    expect(resolution.decision).toBe('ask')
    expect(resolution.evidence.some((item) => item.ruleId === 'R-XS-1')).toBe(true)
    expect(resolution.askHint?.question).toContain('转账')
    expect(resolution.askHint?.slot).toBe('targetScene')
    expect(resolution.confidence).toBe(0.59)
  })

  it('放行时不追问（0.61 档）', () => {
    const allowed = snapshot({
      routeCode: 'ROUTE_OK',
      memories: [memory([{ name: 'payee', value: '王建国' }, { name: 'amountCents', value: 80000 }], 0.9)],
      crossScene: { target: 'transfer', confidence: 0.61, allowed: true, rejectReason: null },
    })
    const resolution = resolveIntent(
      input('上次那个转账再来一次', { recall: allowed }),
      ctx('transfer'),
    )
    expect(resolution.decision).toBe('proceed')
    expect(resolution.requiresPreview).toBe(true)
  })
})

describe('确定性与注入钟（TC-INT-31/32）', () => {
  it('TC-INT-31 同输入连续 1000 次逐字节相等', () => {
    const first = JSON.stringify(resolveIntent(input('上次那个转账再来一次', { recall: HISTORY }), ctx()))
    for (let index = 0; index < 1000; index += 1) {
      const actual = JSON.stringify(resolveIntent(input('上次那个转账再来一次', { recall: HISTORY }), ctx()))
      expect(actual).toBe(first)
    }
  })

  it('TC-INT-32 注入钟决定相对日期，且各自确定', () => {
    const a = resolveIntent(input('最近转了多少'), { scene: 'bills', today: '2026-10-28' })
    const b = resolveIntent(input('最近转了多少'), { scene: 'bills', today: '2026-12-31' })
    const aTime = a.filled.find((item) => item.name === 'timeRange')?.value
    const bTime = b.filled.find((item) => item.name === 'timeRange')?.value
    expect(aTime).toBe('2026-10-21..2026-10-28')
    expect(bTime).toBe('2026-12-24..2026-12-31')
    expect(aTime).not.toBe(bTime)
  })
})

describe('边界与兜底', () => {
  it('提案兜底：无场景词也无咨询模式时返回空数组（正常路径不可达，直接测）', () => {
    expect(buildProposals('给张三转500元')).toEqual([])
    expect(buildProposals('我爱人生日快到了')).toHaveLength(1)
    expect(buildProposals('钱怎么理财好')).toHaveLength(1)
  })

  it('查询动词独占，不被双域误判为歧义', () => {
    const resolution = resolveIntent(input('查一下账单'), ctx('bills'))
    expect(resolution.kind).toBe('explicit')
  })

  it('无候选可借时 askHint 的候选为空数组', () => {
    const resolution = resolveIntent(input('转500给他'), ctx())
    expect(resolution.askHint?.candidates).toEqual([])
  })

  it('askHint 从记忆里取同槽位候选', () => {
    const recall = snapshot({
      memories: [memory([{ name: 'payee', value: '王建国' }], 0.8)],
    })
    const resolution = resolveIntent(input('转500给他', { recall }), ctx())
    expect(resolution.askHint?.candidates).toHaveLength(1)
    expect(resolution.askHint?.candidates[0]?.value).toBe('王建国')
  })

  it('证据里的槽位来源与最终 filled 对齐', () => {
    const resolution = resolveIntent(
      input('给张三转500元'),
      ctx(),
    )
    const exp = resolution.evidence.find((item) => item.ruleId === 'R-EXP-1')
    expect(exp?.slot).toBeUndefined()
  })

  it('金额单位是分（500 元 = 50000）', () => {
    const resolution = resolveIntent(input('给张三转500元'), ctx())
    expect(resolution.filled.find((item) => item.name === 'amountCents')?.value).toBe(50000)
  })
})

describe('卡片场景（场景 4）', () => {
  it('C5 卡场景不再追问账户：冻结判 explicit 且不缺槽', () => {
    const resolution = resolveIntent(input('把这张卡冻结一下'), ctx('card'))
    expect(resolution.kind).toBe('explicit')
    expect(resolution.askHint).toBeNull()
    expect(resolution.missing).toEqual([])
  })

  it('C6 「我卡丢了」判 explicit 且命中 R-EXP-1', () => {
    const resolution = resolveIntent(input('我卡丢了，赶紧挂失'), ctx('card'))
    expect(resolution.kind).toBe('explicit')
    expect(resolution.evidence.some((item) => item.ruleId === 'R-EXP-1')).toBe(true)
  })

  it('C7 「钱包被偷了」无动作动词 → 不冒充 explicit', () => {
    const resolution = resolveIntent(input('钱包被偷了'), ctx('card'))
    expect(resolution.kind).not.toBe('explicit')
  })

  it('C8 金额槽位在卡场景仍可抽取', () => {
    const normalized = normalizeUtteranceSlots('把额度降到 5000', TODAY, 'card')
    expect(normalized.slots.some((slot) => slot.name === 'amountCents')).toBe(true)
  })
})
