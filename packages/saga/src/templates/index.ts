/**
 * 补偿模板注册表（SA-10 §3.1，批 3 数据面）。
 *
 * - 注册即校验：`payload_projection` 必须是合法 JSON 且字段映射完备；
 *   `MANUAL_ONLY` 不得配 `amount_threshold`；版本不可覆盖。
 * - 计划期绑定：每个副作用步骤必须命中 ACTIVE 模板并冻结版本
 *   （无模板 / `IRREVERSIBLE` 用了非 `MANUAL_ONLY` → `no-template`）。
 * - 载荷投影：声明式字段映射的**纯函数**，零 LLM、零外部调用。
 * - `boundFor` 读回计划期冻结的 `(templateId, templateVersion)`，不重新选版。
 */

import { BahError } from '@bah/util'

import { SAGA_STORE, SAGA_TEMPLATES } from '../seams.ts'

import type { Context } from '@bah/core'

import type { PlannedStep } from '../coordinator/plan.ts'
import type { SagaStore, SagaTemplates, SagaTx } from '../seams.ts'
import type { CompKind, CompTemplate, PayloadFieldRule, PayloadProjection } from '../types.ts'

const COMP_KINDS: ReadonlySet<string> = new Set<CompKind>([
  'FULL_REFUND',
  'PARTIAL',
  'CANCEL_BOOKING',
  'CANCEL_IN_FLIGHT',
  'RELEASE_LOCK',
  'NO_OP',
  'MANUAL_ONLY',
])

const TEMPLATE_STATUS = new Set(['ACTIVE', 'DEPRECATED'])

/**
 * 注册期校验（失败即抛，调用方不得写入 `comp_template`）。
 *
 * @throws `BahError('invalid-template')`
 */
export function validateTemplate(template: CompTemplate): void {
  if (typeof template.templateId !== 'string' || template.templateId.length === 0) {
    fail('templateId 必须是非空字符串', { templateId: template.templateId })
  }
  if (!Number.isInteger(template.templateVersion) || template.templateVersion < 1) {
    fail('templateVersion 必须是 ≥ 1 的整数', { templateVersion: template.templateVersion })
  }
  if (typeof template.targetTool !== 'string' || template.targetTool.length === 0) {
    fail('targetTool 必须是非空字符串', { targetTool: template.targetTool })
  }
  if (!COMP_KINDS.has(template.compKind)) {
    fail('compKind 不在冻结枚举内', { compKind: template.compKind })
  }
  if (typeof template.compEndpoint !== 'string' || template.compEndpoint.length === 0) {
    fail('compEndpoint 必须是非空字符串', { compEndpoint: template.compEndpoint })
  }
  if (typeof template.compIdempotent !== 'boolean') {
    fail('compIdempotent 必须是布尔', { compIdempotent: template.compIdempotent })
  }
  if (typeof template.approvalRequired !== 'boolean') {
    fail('approvalRequired 必须是布尔', { approvalRequired: template.approvalRequired })
  }
  if (template.deadlineRule !== undefined && typeof template.deadlineRule !== 'string') {
    fail('deadlineRule 必须是字符串', { deadlineRule: template.deadlineRule })
  }
  if (
    template.amountThreshold !== undefined &&
    (typeof template.amountThreshold !== 'number' ||
      !Number.isFinite(template.amountThreshold) ||
      template.amountThreshold < 0)
  ) {
    fail('amountThreshold 必须是 ≥ 0 的有限数', { amountThreshold: template.amountThreshold })
  }
  if (typeof template.payloadProjection !== 'string' || template.payloadProjection.length === 0) {
    fail('payloadProjection 必须是非空 JSON 字符串', {
      payloadProjection: template.payloadProjection,
    })
  }
  if (
    !Array.isArray(template.residualRules) ||
    template.residualRules.some((rule) => typeof rule !== 'string' || rule.length === 0)
  ) {
    fail('residualRules 必须是字符串数组且元素非空', { residualRules: template.residualRules })
  }
  if (typeof template.status !== 'string' || !TEMPLATE_STATUS.has(template.status)) {
    fail('status 只能是 ACTIVE / DEPRECATED', { status: template.status })
  }
  if (template.compKind === 'MANUAL_ONLY' && template.amountThreshold !== undefined) {
    fail('MANUAL_ONLY 模板不得配置 amountThreshold（人工专属，禁止金额自动判定）', {
      templateId: template.templateId,
      amountThreshold: template.amountThreshold,
    })
  }
  validateProjection(template)
}

function validateProjection(template: CompTemplate): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(template.payloadProjection)
  } catch (error) {
    fail('payloadProjection 不是合法 JSON', {
      templateId: template.templateId,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('payloadProjection 必须是对象', { templateId: template.templateId })
  }
  const fields = (parsed as { readonly fields?: unknown }).fields
  if (!Array.isArray(fields) || fields.length === 0) {
    fail('payloadProjection.fields 必须是非空数组（字段映射完备）', {
      templateId: template.templateId,
    })
  }
  const seen = new Set<string>()
  for (const field of fields) {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) {
      fail('payloadProjection.fields 的每一项必须是对象', { templateId: template.templateId })
    }
    const rule = field as PayloadFieldRule
    if (
      typeof rule.from !== 'string' ||
      rule.from.length === 0 ||
      rule.from.split('.').some((part) => part.length === 0)
    ) {
      fail('payloadProjection 的 from 必须是非空点路径', {
        templateId: template.templateId,
        from: rule.from,
      })
    }
    if (
      typeof rule.to !== 'string' ||
      rule.to.length === 0 ||
      rule.to.split('.').some((part) => part.length === 0)
    ) {
      fail('payloadProjection 的 to 必须是非空点路径', {
        templateId: template.templateId,
        to: rule.to,
      })
    }
    if (seen.has(rule.to)) {
      fail('payloadProjection 的 to 不可重复（后写会静默覆盖前写）', {
        templateId: template.templateId,
        to: rule.to,
      })
    }
    seen.add(rule.to)
  }
}

/**
 * 注册一条模板版本（配置期）。
 *
 * 同 `(templateId, templateVersion)` 已存在 → 拒绝（版本冻结，不允许覆盖已绑定版本的语义）。
 */
export function registerTemplate(ctx: Context, template: CompTemplate): void {
  validateTemplate(template)
  const store = ctx.get(SAGA_STORE)
  if (store.readTemplate(template.templateId, template.templateVersion) !== undefined) {
    fail(`模板版本已存在，禁止覆盖：${template.templateId}@v${template.templateVersion}`, {
      templateId: template.templateId,
      templateVersion: template.templateVersion,
    })
  }
  store.insertTemplate(template)
}

/**
 * PLAN 期绑定：每个副作用步骤必须命中 ACTIVE 模板并冻结版本。
 *
 * 先在内存里校验全部步骤（任一步失败 → 一条都不写），再单提交段写入，
 * 保证计划期不会留下"半绑定"的 saga。
 *
 * 调用方若已在计划期的 `store.tx` 内（SA-08 `planSaga` 的同一提交段），必须把 `tx`
 * 传进来——否则会嵌套 `BEGIN IMMEDIATE`（sqlite 直接报错）。
 *
 * @throws `BahError('no-template')`
 */
export function bindAtPlan(
  ctx: Context,
  sagaId: string,
  steps: readonly PlannedStep[],
  tx?: SagaTx,
): void {
  const templates = ctx.get(SAGA_TEMPLATES)
  const store = ctx.get(SAGA_STORE)
  const bindings: { readonly stepId: string; readonly template: CompTemplate }[] = []

  for (const step of steps) {
    if (step.sideEffectClass === 'NONE') continue
    const template = templates.findActive(step.toolName)
    if (template === undefined) {
      throw new BahError(
        'no-template',
        `bah-saga: no-template: 副作用步骤 ${step.stepId} 无 ACTIVE 模板`,
        { sagaId, stepId: step.stepId, toolName: step.toolName },
      )
    }
    if (step.sideEffectClass === 'IRREVERSIBLE' && template.compKind !== 'MANUAL_ONLY') {
      throw new BahError(
        'no-template',
        'bah-saga: no-template: IRREVERSIBLE 步骤只允许 MANUAL_ONLY 模板',
        { sagaId, stepId: step.stepId, compKind: template.compKind },
      )
    }
    bindings.push({ stepId: step.stepId, template })
  }

  if (bindings.length === 0) return
  const write = (target: SagaTx): void => {
    for (const binding of bindings) target.bindCompensation(sagaId, binding.stepId, binding.template)
  }
  if (tx === undefined) {
    store.tx(write)
  } else {
    write(tx)
  }
}

/**
 * 补偿载荷 = 模板 `payload_projection`（声明式字段映射）+ 正向快照。
 *
 * 纯函数、无 I/O：同输入逐字节相等；缺失字段取 `rule.default`。
 */
export function projectPayload(
  template: CompTemplate,
  stepSnapshot: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const projection = parseProjection(template)
  const out: Record<string, unknown> = {}
  for (const rule of projection.fields) {
    const value = readPath(stepSnapshot, rule.from)
    setPath(out, rule.to, value ?? rule.default)
  }
  return out
}

function parseProjection(template: CompTemplate): PayloadProjection {
  try {
    const parsed = JSON.parse(template.payloadProjection) as PayloadProjection
    if (!Array.isArray(parsed.fields)) throw new Error('fields 不是数组')
    return parsed
  } catch (error) {
    throw new BahError('invalid-template', 'bah-saga: invalid-template: payloadProjection 不可解析', {
      templateId: template.templateId,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

function readPath(source: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = source
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined
    cursor = (cursor as Readonly<Record<string, unknown>>)[part]
  }
  return cursor
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      cursor[part] = created
      cursor = created
    } else {
      cursor = next as Record<string, unknown>
    }
  }
  cursor[parts[parts.length - 1] as string] = value
}

/** 装配模板注册表（读取按服务键惰性解析，允许先于存储插件 apply）。 */
export function installTemplates(ctx: Context): void {
  const store = (): SagaStore => ctx.get(SAGA_STORE)
  const impl: SagaTemplates = {
    findActive(toolName) {
      return store().findActiveTemplate(toolName)
    },
    bind(sagaId, stepId, template) {
      store().tx((tx) => tx.bindCompensation(sagaId, stepId, template))
    },
    boundFor(sagaId, stepId) {
      const action = store().tx((tx) =>
        tx.listCompensations(sagaId).find((comp) => comp.stepId === stepId),
      )
      if (action === undefined) return undefined
      return store().readTemplate(action.templateId, action.templateVersion)
    },
  }
  ctx.provide(SAGA_TEMPLATES, impl)
}

function fail(message: string, detail?: unknown): never {
  throw new BahError('invalid-template', `bah-saga: invalid-template: ${message}`, detail)
}
