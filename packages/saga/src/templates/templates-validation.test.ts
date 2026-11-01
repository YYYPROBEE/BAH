/**
 * 补偿模板的注册期校验面与载荷投影边界（补 `templates.test.ts` 未触及的分支）。
 *
 * 为什么值得钉：`comp_template` 是补偿载荷的**唯一定义处**——注册期放过一条坏约束，
 * 运行期就会按错误的字段映射把钱退到错误的地方（重复 `to` = 后写静默覆盖前写）。
 * 投影本身是纯函数，因此这里全部离线、无外部调用。
 *
 * 反例（`it.each` 表）逐条断言「拒绝」且「未落库」；正例证明校验器没有严到拒掉合法模板。
 */

import { createContext } from '@bah/core'
import { createSagaStore } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import { SAGA_STORE, SAGA_TEMPLATES } from '../seams.ts'
import {
  installTemplates,
  projectPayload,
  registerTemplate,
  validateTemplate,
} from './index.ts'

import type { Context } from '@bah/core'
import type { SagaStore } from '../seams.ts'
import type { CompTemplate } from '../types.ts'

const PROJECTION = JSON.stringify({
  fields: [{ from: 'payment.amount', to: 'amount' }, { from: 'payment.note', to: 'memo' }],
})

function template(overrides: Partial<CompTemplate> = {}): CompTemplate {
  return {
    templateId: 'refund-template',
    templateVersion: 1,
    targetTool: 'payment.charge',
    compKind: 'FULL_REFUND',
    compEndpoint: '/comp/refund',
    compIdempotent: true,
    residualRules: ['FEE'],
    approvalRequired: false,
    payloadProjection: PROJECTION,
    status: 'ACTIVE',
    ...overrides,
  }
}

function harness(): { ctx: Context; store: SagaStore } {
  const store = createSagaStore({ dbPath: ':memory:' })
  const ctx = createContext()
  ctx.provide(SAGA_STORE, store)
  installTemplates(ctx)
  return { ctx, store }
}

/**
 * 每条只违反一项已声明的注册期约束，并断言**具体拒因文案**——
 * 只断言 `invalid-template` 的话，任何一条校验被删都会有别的校验顶上，表格就白跑了。
 */
const REJECTS: readonly {
  readonly name: string
  readonly patch: Record<string, unknown>
  readonly reason: string
}[] = [
  { name: 'templateId 空串', patch: { templateId: '' }, reason: 'templateId 必须是非空字符串' },
  { name: 'templateId 非字符串', patch: { templateId: 42 }, reason: 'templateId 必须是非空字符串' },
  { name: 'templateVersion 为 0', patch: { templateVersion: 0 }, reason: 'templateVersion 必须是 ≥ 1 的整数' },
  { name: 'templateVersion 非整数', patch: { templateVersion: 1.5 }, reason: 'templateVersion 必须是 ≥ 1 的整数' },
  { name: 'targetTool 空串', patch: { targetTool: '' }, reason: 'targetTool 必须是非空字符串' },
  { name: 'compKind 不在冻结枚举内', patch: { compKind: 'REFUND' }, reason: 'compKind 不在冻结枚举内' },
  { name: 'compEndpoint 空串', patch: { compEndpoint: '' }, reason: 'compEndpoint 必须是非空字符串' },
  { name: 'compIdempotent 非布尔', patch: { compIdempotent: 'true' }, reason: 'compIdempotent 必须是布尔' },
  { name: 'approvalRequired 缺失', patch: { approvalRequired: undefined }, reason: 'approvalRequired 必须是布尔' },
  { name: 'deadlineRule 非字符串', patch: { deadlineRule: 5_000 }, reason: 'deadlineRule 必须是字符串' },
  { name: 'amountThreshold 为负', patch: { amountThreshold: -1 }, reason: 'amountThreshold 必须是 ≥ 0 的有限数' },
  { name: 'amountThreshold 为 NaN', patch: { amountThreshold: Number.NaN }, reason: 'amountThreshold 必须是 ≥ 0 的有限数' },
  { name: 'payloadProjection 空串', patch: { payloadProjection: '' }, reason: 'payloadProjection 必须是非空 JSON 字符串' },
  { name: 'payloadProjection 非法 JSON', patch: { payloadProjection: '{oops' }, reason: 'payloadProjection 不是合法 JSON' },
  { name: 'payloadProjection 是数组', patch: { payloadProjection: '[]' }, reason: 'payloadProjection 必须是对象' },
  { name: 'payloadProjection.fields 为空', patch: { payloadProjection: '{"fields":[]}' }, reason: 'fields 必须是非空数组' },
  {
    name: 'payloadProjection.fields 不是数组',
    patch: { payloadProjection: '{"fields":"nope"}' },
    reason: 'fields 必须是非空数组',
  },
  {
    name: 'fields 项不是对象',
    patch: { payloadProjection: '{"fields":["amount"]}' },
    reason: 'fields 的每一项必须是对象',
  },
  {
    name: 'from 含空点段',
    patch: { payloadProjection: '{"fields":[{"from":"payment..amount","to":"amount"}]}' },
    reason: 'from 必须是非空点路径',
  },
  {
    name: 'to 含空点段',
    patch: { payloadProjection: '{"fields":[{"from":"payment.amount","to":".amount"}]}' },
    reason: 'to 必须是非空点路径',
  },
  {
    name: 'to 重复（后写会静默覆盖前写）',
    patch: {
      payloadProjection:
        '{"fields":[{"from":"payment.amount","to":"amount"},{"from":"payment.backup","to":"amount"}]}',
    },
    reason: 'to 不可重复',
  },
  { name: 'residualRules 非数组', patch: { residualRules: 'FEE' }, reason: 'residualRules 必须是字符串数组且元素非空' },
  { name: 'residualRules 含空串', patch: { residualRules: ['FEE', ''] }, reason: 'residualRules 必须是字符串数组且元素非空' },
  { name: 'status 非 ACTIVE/DEPRECATED', patch: { status: 'DRAFT' }, reason: 'status 只能是 ACTIVE / DEPRECATED' },
]

describe('补偿模板注册期校验（逐条约束）', () => {
  it.each(REJECTS)('$name → 按该条约束拒绝，且一行都不写', ({ patch, reason }) => {
    const { ctx, store } = harness()
    const bad = { ...template(), ...patch } as CompTemplate

    expect(() => validateTemplate(bad)).toThrowError(new RegExp(reason))
    expect(() => registerTemplate(ctx, bad)).toThrowError(new RegExp(reason))

    // 关键：拒绝发生在写入之前（`comp_template` 不能留下半成品）。
    expect(store.findActiveTemplate('payment.charge')).toBeUndefined()
    expect(store.readTemplate(bad.templateId, bad.templateVersion)).toBeUndefined()
  })

  it('正例：带 deadlineRule / amountThreshold / 嵌套映射的合法模板注册成功', () => {
    const { ctx, store } = harness()
    const ok = template({
      deadlineRule: 'T+1',
      amountThreshold: 0,
      payloadProjection: JSON.stringify({
        fields: [{ from: 'payment.amount', to: 'refund.amount', default: 0 }],
      }),
    })

    registerTemplate(ctx, ok)
    expect(store.findActiveTemplate('payment.charge')).toMatchObject({
      templateId: 'refund-template',
      amountThreshold: 0,
      deadlineRule: 'T+1',
    })
  })

  it('MANUAL_ONLY 允许不配金额阈值，但配了任何值都拒（含 0）', () => {
    const { ctx } = harness()
    expect(() =>
      validateTemplate(template({ compKind: 'MANUAL_ONLY', amountThreshold: 0 })),
    ).toThrowError(/MANUAL_ONLY/)
    expect(() => validateTemplate(template({ compKind: 'MANUAL_ONLY' }))).not.toThrow()
    expect(() => registerTemplate(ctx, template({ compKind: 'MANUAL_ONLY' }))).not.toThrow()
  })
})

describe('载荷投影的取值与落位边界', () => {
  it('共享前缀的 to 落进同一嵌套对象，且逐字节可重现', () => {
    const compiled = template({
      payloadProjection: JSON.stringify({
        fields: [
          { from: 'a.x', to: 'refund.amount' },
          { from: 'a.y', to: 'refund.channel.code' },
          { from: 'a.missing', to: 'note', default: 'N/A' },
        ],
      }),
    })
    const snapshot = { a: { x: 100, y: 'alipay' } }

    const first = projectPayload(compiled, snapshot)
    expect(first).toEqual({ refund: { amount: 100, channel: { code: 'alipay' } }, note: 'N/A' })
    expect(JSON.stringify(projectPayload(compiled, snapshot))).toBe(JSON.stringify(first))
  })

  it('from 穿过数组或 null 视为缺失：有默认取默认，无默认保留空键位', () => {
    const compiled = template({
      payloadProjection: JSON.stringify({
        fields: [
          { from: 'tags.inner', to: 't', default: 'D' },
          { from: 'a.b.c', to: 'u' },
        ],
      }),
    })

    expect(Object.keys(projectPayload(compiled, { tags: ['x'], a: null }))).toEqual(['t', 'u'])
    expect(projectPayload(compiled, { tags: ['x'], a: null })).toEqual({ t: 'D' })
  })

  it('特征化：浅层 to 与深层 to 前缀相撞时，浅层的值被丢弃——注册期并不禁止这种写法', () => {
    // 刻意钉住现状（不是背书）：`validateTemplate` 只查 `to` 全等重复，未查前缀包含。
    // 若将来把这条补成注册期约束，本用例会红，届时按新语义改写而不是静默漂移。
    const compiled = template({
      payloadProjection: JSON.stringify({
        fields: [
          { from: 'a.x', to: 'r' },
          { from: 'a.y', to: 'r.deep' },
        ],
      }),
    })

    expect(projectPayload(compiled, { a: { x: 1, y: 2 } })).toEqual({ r: { deep: 2 } })
  })

  it('绕过注册期写进库的坏投影，在投影时 fail-loud（不是返回空载荷）', () => {
    const { store } = harness()
    const corrupt = template({ templateId: 'corrupt', payloadProjection: '{"fields":"nope"}' })
    store.insertTemplate(corrupt)

    expect(() => projectPayload(corrupt, { payment: { amount: 1 } })).toThrowError(/invalid-template/)
    expect(() => projectPayload(corrupt, { payment: { amount: 1 } })).toThrowError(
      /payloadProjection 不可解析/,
    )

    const unparseable = template({ templateId: 'unparseable', payloadProjection: 'nope' })
    store.insertTemplate(unparseable)
    expect(() => projectPayload(unparseable, {})).toThrowError(/invalid-template/)
  })

  it('boundFor 读不到补偿行时返回 undefined（而不是抛或返回任意 ACTIVE 模板）', () => {
    const { ctx, store } = harness()
    registerTemplate(ctx, template())

    expect(store.findActiveTemplate('payment.charge')).toBeDefined()
    expect(ctx.get(SAGA_TEMPLATES).boundFor('saga-unknown', 's1')).toBeUndefined()
  })
})
