/**
 * 出参契约表的**完备性**检查（W03）。
 *
 * 为什么要有这个文件：`result-schemas.ts` 是出参形状的唯一真相源，
 * 但它是一张 `Partial<Record<...>>`——**少写一个工具，TypeScript 不会报错，运行时静默跳过校验**。
 * 这类"漏了就无声"的缺口只能靠清单测试兜住。
 *
 * 四条断言对应四种漏法：
 * 1. 漏写某个工具 → 第 1 条红；
 * 2. 写了空气（非 object 根）→ 第 2 条红；
 * 3. 表里混进不存在的工具名（改名后残留）→ 第 3 条红；
 * 4. 表里多出一个不是工具名的键 → 同第 3 条。
 */

import { describe, expect, it } from 'vitest'

import { validateAgainstSchema } from '@bah/util'

import type {
  CutoffFindingView,
  SpendSplitView,
  SubscriptionItemView,
  SubscriptionListResult,
  SubscriptionSeriesView,
} from './dto.ts'
import type {
  SubscriptionAuthorizationRevokedResult,
  SubscriptionWatchResult,
} from './subscriptions.ts'
import { BANK_RESULT_SCHEMAS } from './result-schemas.ts'
import { BANK_TOOL_NAMES } from './specs.ts'

describe('出参契约表完备性', () => {
  it('28 个工具一个不少（漏写 = 静默不校验）', () => {
    const missing = BANK_TOOL_NAMES.filter((name) => BANK_RESULT_SCHEMAS[name] === undefined)
    expect(missing, `这些工具没有出参契约：${missing.join(', ')}`).toEqual([])
  })

  it('每份契约都是 object 根（否则连"是不是对象"都验不了）', () => {
    for (const name of BANK_TOOL_NAMES) {
      const schema = BANK_RESULT_SCHEMAS[name]
      expect(schema?.type, `${name} 的 type 不是 object`).toBe('object')
    }
  })

  it('表里没有多余键（改名/删工具后的残留会在这里暴露）', () => {
    const known = new Set<string>(BANK_TOOL_NAMES)
    const extra = Object.keys(BANK_RESULT_SCHEMAS).filter((key) => !known.has(key))
    expect(extra, `表里有非工具名键：${extra.join(', ')}`).toEqual([])
  })

  it('每份契约都声明了必填约束（required，或 oneOf 的分支各自 required）', () => {
    for (const name of BANK_TOOL_NAMES) {
      const schema = BANK_RESULT_SCHEMAS[name]
      const required = schema?.required
      const branches = schema?.oneOf
      const hasRequired = Array.isArray(required) && required.length > 0
      const branchRequired =
        Array.isArray(branches) &&
        branches.length > 0 &&
        branches.every((branch) => Array.isArray(branch.required) && branch.required.length > 0)
      expect(hasRequired || branchRequired, `${name} 没有 required，也没有带必填的分支`).toBe(true)
    }
  })
})

/* ── D-18：DTO ↔ schema 字段逐项（既有测试只查覆盖，不查字段） ───────────── */

/**
 * 用 `Record<keyof T, true>` 钉住字段集合：DTO 加字段而这里忘写 → **编译失败**；
 * schema 少写/多写 → 运行时红。这比 `keyof` 数组更严（数组可以少写）。
 */
const LIST_KEYS: Readonly<Record<keyof SubscriptionListResult, true>> = {
  confirmed: true,
  detected: true,
  spendSplit: true,
  cutoffFindings: true,
  detectedAt: true,
  basis: true,
  detectorVersion: true,
}
const ITEM_KEYS: Readonly<Record<keyof SubscriptionItemView, true>> = {
  subscriptionId: true,
  merchant: true,
  merchantKey: true,
  cycle: true,
  amountCents: true,
  monthlyCents: true,
  nextChargeAt: true,
  status: true,
  note: true,
  reminderAheadDays: true,
  contractEndAt: true,
  pauseUntil: true,
  authorizationStatus: true,
}
const SERIES_KEYS: Readonly<Record<keyof SubscriptionSeriesView, true>> = {
  merchantKey: true,
  displayName: true,
  kind: true,
  cycle: true,
  amountCents: true,
  monthlyCents: true,
  confidence: true,
  nextChargeAt: true,
  count: true,
  priceHike: true,
  priceDrop: true,
  trialConverted: true,
  suspectedInstallment: true,
  matchedSubscriptionId: true,
}
const SPLIT_KEYS: Readonly<Record<keyof SpendSplitView, true>> = {
  subscriptionCents: true,
  billCents: true,
  installmentCents: true,
  subscriptionCount: true,
  billCount: true,
  installmentCount: true,
}
const CUTOFF_KEYS: Readonly<Record<keyof CutoffFindingView, true>> = {
  kind: true,
  verdict: true,
  merchantKey: true,
  subscriptionId: true,
  authorizationId: true,
  level: true,
  hint: true,
  dueAt: true,
}
const WATCH_KEYS: Readonly<Record<keyof SubscriptionWatchResult, true>> = {
  subscriptionId: true,
  merchant: true,
  watch: true,
  aheadDays: true,
  note: true,
  reminderAheadDays: true,
  at: true,
}
const AUTHORIZE_KEYS: Readonly<Record<keyof SubscriptionAuthorizationRevokedResult, true>> = {
  authorizationId: true,
  merchant: true,
  status: true,
  affected: true,
  affectedSubscriptions: true,
  restoreHint: true,
  verifyBy: true,
  revokedAt: true,
}

function schemaProperties(schema: unknown): readonly string[] {
  const record = schema as { properties?: Record<string, unknown> } | undefined
  return Object.keys(record?.properties ?? {}).sort()
}

function expectKeys(schema: unknown, dto: Readonly<Record<string, true>>, label: string): void {
  expect(schemaProperties(schema), label).toEqual(Object.keys(dto).sort())
}

describe('D-18 新工具 DTO ↔ schema 字段逐项', () => {
  it('sub_list：顶层 + 五个嵌套结构逐字段对齐', () => {
    const schema = BANK_RESULT_SCHEMAS.sub_list
    expect(schema).toBeDefined()
    expectKeys(schema, LIST_KEYS, 'sub_list')
    const properties = (schema as { properties: Record<string, unknown> }).properties
    expectKeys(
      (properties['confirmed'] as { items: unknown }).items,
      ITEM_KEYS,
      'sub_list.confirmed[]',
    )
    expectKeys(
      (properties['detected'] as { items: unknown }).items,
      SERIES_KEYS,
      'sub_list.detected[]',
    )
    expectKeys(properties['spendSplit'], SPLIT_KEYS, 'sub_list.spendSplit')
    expectKeys(
      (properties['cutoffFindings'] as { items: unknown }).items,
      CUTOFF_KEYS,
      'sub_list.cutoffFindings[]',
    )
  })

  it('sub_watch：字段逐项对齐', () => {
    expectKeys(BANK_RESULT_SCHEMAS.sub_watch, WATCH_KEYS, 'sub_watch')
  })

  it('sub_authorize：字段逐项对齐', () => {
    expectKeys(BANK_RESULT_SCHEMAS.sub_authorize, AUTHORIZE_KEYS, 'sub_authorize')
  })
})

/* ── R-8：risk_assess 的 questions / submit 两个分支（旧写法缺 answers 也能过） ── */

const QUESTIONS_OK: Readonly<Record<string, unknown>> = {
  action: 'questions',
  questionnaireId: 'rq-1',
  version: 'risk-q-v1',
  issuedAt: 1_792_000_000_000,
  expiresAt: 1_792_000_600_000,
  questions: [
    {
      index: 1,
      title: '您的投资经验？',
      options: [
        { key: 'conservative', text: '没有经验', score: 1 },
        { key: 'middle', text: '有一些', score: 3 },
        { key: 'aggressive', text: '很丰富', score: 5 },
      ],
    },
  ],
  at: 1_792_000_000_000,
}

const SUBMIT_OK: Readonly<Record<string, unknown>> = {
  action: 'submit',
  questionnaireId: 'rq-1',
  version: 'risk-q-v1',
  answers: [{ index: 1, key: 'middle' }],
  score: 3,
  from: 'R1',
  to: 'R2',
  at: 1_792_000_000_000,
}

/** 去掉一个键（负控造坏形状用；不改原 fixture）。 */
function omit(value: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[key]
  return copy
}

describe('risk_assess 判别式联合（R-8）', () => {
  const check = (value: unknown) =>
    validateAgainstSchema(BANK_RESULT_SCHEMAS.risk_assess, value, 'result')

  it('正例：questions 分支出参通过', () => {
    expect(check(QUESTIONS_OK)).toBeUndefined()
  })

  it('正例：submit 分支出参通过', () => {
    expect(check(SUBMIT_OK)).toBeUndefined()
  })

  it('负控：submit 缺 answers → 契约红（旧的单对象写法会静默通过）', () => {
    const found = check(omit(SUBMIT_OK, 'answers'))
    expect(found?.code).toBe('oneOf')
    expect(found?.detail).toContain('/answers(required)')
  })

  it('负控：questions 缺 questions → 契约红', () => {
    const found = check(omit(QUESTIONS_OK, 'questions'))
    expect(found?.code).toBe('oneOf')
    expect(found?.detail).toContain('/questions(required)')
  })

  it('负控：action=questions 却只带 submit 载荷 → 契约红（action 字面量不能蒙过分支）', () => {
    const found = check({ ...SUBMIT_OK, action: 'questions' })
    expect(found?.code).toBe('oneOf')
  })
})
