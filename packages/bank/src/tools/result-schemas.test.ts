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
  it('19 个工具一个不少（漏写 = 静默不校验）', () => {
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

  it('每份契约都至少声明一个 required（空契约等于没校验，属自欺）', () => {
    for (const name of BANK_TOOL_NAMES) {
      const required = BANK_RESULT_SCHEMAS[name]?.required
      expect(Array.isArray(required) && required.length > 0, `${name} 没有 required`).toBe(true)
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
