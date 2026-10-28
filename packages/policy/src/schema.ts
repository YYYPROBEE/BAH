/**
 * `bank.tier.input/v1` 的输入契约与求值结果契约（施工方案 01 §2）。
 *
 * 三个边界，写在这里而不是散在适配器里：
 * 1. **金额只用整数分**：所有 `*Cents` 都是 int；类型上不存在浮点入口；
 * 2. **PII 不进策略**：没有 `payee.name`、没有 `memo`——规则不允许按姓名判权；
 * 3. **缺字段不兜底**：`validateInput` 要么给出完整对象，要么抛
 *    `policy-input-invalid`，绝不把坏输入当默认值继续算。
 */

import { policyError } from './errors.ts'

/** 三级权限级别（与 `@bah/core` 的 `ToolTierLevel` 逐字一致）。 */
export type TierLevel = 'green' | 'yellow' | 'red'

/** 升级理由（v1 封闭四值；新增词要 schema v2 + 代码更新）。 */
export type TierReason = 'declared' | 'new-payee' | 'daily-limit' | 'risky-calls'

/** 收款人绑定状态（core 预检的 `PayeeBinding`）。 */
export type PayeeBinding = 'new' | 'whitelist'

/** 全部级别，按"由宽到严"排列。 */
export const TIER_LEVELS: readonly TierLevel[] = ['green', 'yellow', 'red']

/** 全部理由。 */
export const TIER_REASONS: readonly TierReason[] = [
  'declared',
  'new-payee',
  'daily-limit',
  'risky-calls',
]

/** 全部绑定状态。 */
export const PAYEE_BINDINGS: readonly PayeeBinding[] = ['new', 'whitelist']

/** 金额分上限（约 100 亿元）：超出即视为坏输入，不是"业务大额"。 */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000

/** 单 turn 风险调用次数上限（与静态分析的值域同一口径）。 */
export const MAX_RISKY_CALLS = 100

/** 策略输入（冻结面：字段只增不改，新增走 `bank.tier.input/v2`）。 */
export interface BankTierInput {
  readonly subject: {
    readonly userId: string
    readonly sessionId: string
  }
  readonly action: {
    readonly name: string
    readonly declared: TierLevel
  }
  /** 仅转账类有；非转账类缺省（表级 `requires` 负责守卫）。 */
  readonly preview?: {
    readonly amountCents: number
    readonly dailyUsedCents: number
    readonly dailyLimitCents: number
    readonly payee: { readonly binding: PayeeBinding }
  }
  readonly state: {
    readonly riskyCallsInTurn: number
    readonly verifyLocked: boolean
  }
  /** 生效上限 = `min(core 账本限额, Config 限额)`；由适配器算好再传进来。 */
  readonly limits: {
    readonly dailyLimitCents: number
  }
  /** 参数值（来自 Config，不由 bundle 持有）。 */
  readonly params: Readonly<Record<string, number>>
}

/** 求值结果（`deny` 存在时治理平面走拒绝，`level/reason` 仍保留用于审计）。 */
export interface TierPolicyResult {
  readonly level: TierLevel
  readonly reason: TierReason
  readonly deny?: { readonly code: string; readonly reason: string }
  /** 命中的每一行（含默认行），顺序 = 表顺序。 */
  readonly ruleIds: readonly string[]
  /** 实际参与求值的表（被 `appliesTo`/`requires` 跳过的不算）。 */
  readonly tables: readonly string[]
}

/** 表达式里可读的字段类型。 */
export type FieldType =
  | { readonly kind: 'int'; readonly min: number; readonly max: number }
  | { readonly kind: 'string' }
  | { readonly kind: 'bool' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }

/** 一个可读字段。 */
export interface SchemaField {
  /** 点分路径（`preview.payee.binding`）。 */
  readonly path: string
  readonly type: FieldType
  /** 所属的可选子树根；有值时该字段只能在声明了 `requires` 的表里引用。 */
  readonly optionalRoot?: string
}

/** 输入 schema 标识（manifest 的 `schema` 只认它）。 */
export const BANK_TIER_SCHEMA = 'bank.tier.input/v1'

/**
 * 表达式可读的字段表。
 *
 * `level` / `reason` 是**求值上下文**，不是输入字段：初始为
 * `action.declared` / `declared`，只能被 `raise`/`keep` 改写。
 */
export const BANK_TIER_FIELDS: readonly SchemaField[] = [
  { path: 'subject.userId', type: { kind: 'string' } },
  { path: 'subject.sessionId', type: { kind: 'string' } },
  { path: 'action.name', type: { kind: 'string' } },
  { path: 'action.declared', type: { kind: 'enum', values: TIER_LEVELS } },
  {
    path: 'preview.amountCents',
    type: { kind: 'int', min: 0, max: MAX_AMOUNT_CENTS },
    optionalRoot: 'preview',
  },
  {
    path: 'preview.dailyUsedCents',
    type: { kind: 'int', min: 0, max: MAX_AMOUNT_CENTS },
    optionalRoot: 'preview',
  },
  {
    path: 'preview.dailyLimitCents',
    type: { kind: 'int', min: 0, max: MAX_AMOUNT_CENTS },
    optionalRoot: 'preview',
  },
  {
    path: 'preview.payee.binding',
    type: { kind: 'enum', values: PAYEE_BINDINGS },
    optionalRoot: 'preview',
  },
  {
    path: 'state.riskyCallsInTurn',
    type: { kind: 'int', min: 0, max: MAX_RISKY_CALLS },
  },
  { path: 'state.verifyLocked', type: { kind: 'bool' } },
  {
    path: 'limits.dailyLimitCents',
    type: { kind: 'int', min: 0, max: MAX_AMOUNT_CENTS },
  },
  { path: 'level', type: { kind: 'enum', values: TIER_LEVELS } },
  { path: 'reason', type: { kind: 'enum', values: TIER_REASONS } },
]

const FIELD_INDEX: ReadonlyMap<string, SchemaField> = new Map(
  BANK_TIER_FIELDS.map((field) => [field.path, field]),
)

/** 按路径取字段；未知返回 `undefined`（调用方决定报哪个码）。 */
export function fieldOf(path: string): SchemaField | undefined {
  return FIELD_INDEX.get(path)
}

/** 某路径是不是某个对象的**前缀**（如 `preview`）：用于"不能直接引用对象"的判定。 */
export function isObjectPrefix(path: string): boolean {
  const prefix = `${path}.`
  return BANK_TIER_FIELDS.some((field) => field.path.startsWith(prefix))
}

/** 参数声明（bundle 的 `parameters`）。 */
export interface ParamSpec {
  readonly min: number
  readonly max: number
}

/**
 * 校验并归一化输入。
 *
 * @param value 任意输入（来自治理平面，可能是模型/插件给的）
 * @param params bundle 声明的参数与边界
 * @throws `policy-input-invalid` 任何必填缺失、类型错、越界、未知参数
 */
export function validateInput(
  value: unknown,
  params: Readonly<Record<string, ParamSpec>>,
): BankTierInput {
  if (!isRecord(value)) throw invalid('$', 'object', value)
  const subject = requireRecord(value['subject'], 'subject')
  const action = requireRecord(value['action'], 'action')
  const state = requireRecord(value['state'], 'state')
  const limits = requireRecord(value['limits'], 'limits')

  const userId = requireString(subject['userId'], 'subject.userId')
  const sessionId = requireString(subject['sessionId'], 'subject.sessionId')
  const name = requireString(action['name'], 'action.name')
  const declared = requireEnum(action['declared'], 'action.declared', TIER_LEVELS)
  const riskyCallsInTurn = requireInt(state['riskyCallsInTurn'], 'state.riskyCallsInTurn', 0, MAX_RISKY_CALLS)
  const verifyLocked = requireBool(state['verifyLocked'], 'state.verifyLocked')
  const dailyLimitCents = requireInt(limits['dailyLimitCents'], 'limits.dailyLimitCents', 0, MAX_AMOUNT_CENTS)

  return deepFreeze({
    subject: { userId, sessionId },
    action: { name, declared },
    ...(value['preview'] === undefined ? {} : { preview: readPreview(value['preview']) }),
    state: { riskyCallsInTurn, verifyLocked },
    limits: { dailyLimitCents },
    params: readParams(value['params'], params),
  })
}

/** `preview` 子树：四个必填字段，金额 int 且非负。 */
function readPreview(value: unknown): NonNullable<BankTierInput['preview']> {
  const preview = requireRecord(value, 'preview')
  const payee = requireRecord(preview['payee'], 'preview.payee')
  return {
    amountCents: requireInt(preview['amountCents'], 'preview.amountCents', 0, MAX_AMOUNT_CENTS),
    dailyUsedCents: requireInt(
      preview['dailyUsedCents'],
      'preview.dailyUsedCents',
      0,
      MAX_AMOUNT_CENTS,
    ),
    dailyLimitCents: requireInt(
      preview['dailyLimitCents'],
      'preview.dailyLimitCents',
      0,
      MAX_AMOUNT_CENTS,
    ),
    payee: { binding: requireEnum(payee['binding'], 'preview.payee.binding', PAYEE_BINDINGS) },
  }
}

/**
 * 参数：**恰好**声明的那几个，不多不少。
 *
 * 多传（bundle 没声明）也是错：否则"改阈值"可以绕过 bundle 的参数契约。
 */
function readParams(
  value: unknown,
  params: Readonly<Record<string, ParamSpec>>,
): Readonly<Record<string, number>> {
  const record = requireRecord(value, 'params')
  const declared = Object.keys(params).sort()
  const actual = Object.keys(record).sort()
  if (declared.length !== actual.length || declared.some((key, index) => key !== actual[index])) {
    throw policyError(
      'policy-input-invalid',
      `params 必须恰好是 [${declared.join(', ')}]，实际 [${actual.join(', ')}]`,
      { field: 'params', expected: declared.join(','), actual: actual.join(',') },
    )
  }
  const result: Record<string, number> = {}
  for (const [key, spec] of Object.entries(params).sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    result[key] = requireInt(record[key], `params.${key}`, spec.min, spec.max)
  }
  return result
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(field, 'object', value)
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(field, 'non-empty string', value)
  }
  return value
}

function requireBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(field, 'boolean', value)
  return value
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalid(field, `integer ${String(min)}..${String(max)}`, value)
  }
  if (value < min || value > max) throw invalid(field, `integer ${String(min)}..${String(max)}`, value)
  return value
}

function requireEnum<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw invalid(field, values.join('|'), value)
  }
  return value as T
}

/** 统一的输入错误（detail 里带字段名，便于治理平面定位）。 */
function invalid(field: string, expected: string, actual: unknown): Error {
  return policyError('policy-input-invalid', `${field} 必须是 ${expected}`, {
    field,
    expected,
    actual: typeof actual === 'object' ? JSON.stringify(actual) : String(actual),
  })
}

/** 深冻结：求值器承诺不改输入，冻结让"改了"当场炸出来。 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const item of Object.values(value)) deepFreeze(item)
  return Object.freeze(value)
}

/** 任意值 → 记录的窄化（不认数组与 null）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
