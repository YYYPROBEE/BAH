/**
 * 工具契约的**校验器子集**（W03 出口 1/2 的执行件）。
 *
 * ## 为什么不在 `tool-contract.ts` 里实现
 *
 * W03 §2 的字面落点写的是「`packages/util/src/tool-contract.ts`：实现校验器子集」，
 * 但 W02 的 `TC-W02-01` 冻结了那个文件：**不得有任何运行时导出**（只 interface / type）。
 * 两条施工单在这里直接冲突。
 *
 * 处置：**保住门禁，另起一个文件**。`tool-contract.ts` 继续纯类型，
 * 校验器放这里。这样 TC-W02-01 不被破坏，W03 的能力也落地。
 * （已登记在 PROGRESS 的 W03 偏差里，不悄悄改任何一边。）
 *
 * ## 为什么是"子集"而不是 JSON Schema 全量
 *
 * 宪法 R-2 零运行时依赖 ⇒ 不能引 `ajv` / `zod`。
 * 14 个工具的参数实测只需要这些关键字：`type` / `required` / `enum` / `minimum` /
 * `maximum` / `exclusiveMinimum` / `exclusiveMaximum` / `minLength` / `maxLength` /
 * `pattern` / `multipleOf` / `properties` / `items` / `additionalProperties: false`。
 *
 * **`multipleOf` 是 W03 的 TC 逼出来的**：`TC-W03-02 ④` 要求 `19.999` 被判非法，
 * 而 W03 §2 列的九类规则里没有任何一条能表达"最多两位小数"。所以补这一个。
 *
 * ## 边界：这里**不**做什么
 *
 * - 不处理金额单位换算（`yuanToCents` 在 `@bah/bank`，util 不能依赖它）；
 * - 不处理"超安全整数"（同上，属 bank 侧的钱校验）；
 * - 不抛异常：**永远返回 `ToolContractViolation | undefined`**。
 *   抛错会让 `pipeline` 的归一化路径多一条分支，而本仓要求"错误只有一种形状"。
 */

import type { ToolContractViolation } from './tool-contract.ts'

/**
 * 本包认得的 schema 形状。
 *
 * 为什么不用 `ToolSchema`：`@bah/core` 依赖 `@bah/util`（实测），util 反向 import core 会成包级环。
 * 这里用结构化类型，`ToolSchema` 天然可赋值给它（结构兼容），调用方不需要转换。
 */
export type StructSchema = Readonly<Record<string, unknown>>

/** 校验方向（决定返回的 `phase`）。 */
export type ValidatePhase = 'args' | 'result'

/** 路径拼接：空串表示根。 */
function child(path: string, key: string | number): string {
  return `${path}/${String(key)}`
}

/** 失败构造（唯一出口，保证形状统一）。 */
function violation(
  phase: ValidatePhase,
  path: string,
  code: string,
  detail: string,
): ToolContractViolation {
  return { phase, path, code, detail }
}

/** JSON 类型名 → 判定。`integer` 是 `number` 的子集，单独一层。 */
function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      // 未识别的 type 视为**不通过**：宁可拦下，也不要"不认识的类型就放行"
      return false
  }
}

/**
 * 校验一个值是否符合 schema。
 *
 * **`schema` 形参是 `unknown` 而不是 `StructSchema`**，这是有意的：
 * `@bah/core` 的 `ToolSchema` 是 `interface`，**没有索引签名**，结构上赋不给
 * `Readonly<Record<string, unknown>>`（TS 会报 "Index signature is missing"）。
 * 与其在调用点写 `as` 强转，不如在这里收窄一次——schema 本来就是数据，运行时能验形状。
 *
 * @param schema - 契约里的 `argsSchema` / `resultSchema`
 * @param value - 实际入参 / 出参
 * @param phase - 决定违规项里的 `phase`
 * @returns 第一个违规项；全部通过返回 `undefined`
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
  phase: ValidatePhase,
): ToolContractViolation | undefined {
  if (!isSchema(schema)) {
    // schema 本身不是对象 = 契约写错了，必须报出来而不是"当作没有约束"
    return violation(phase, '', 'schema-invalid', 'schema 不是对象')
  }
  return walk(schema, value, '', phase)
}

function walk(
  schema: StructSchema,
  value: unknown,
  path: string,
  phase: ValidatePhase,
): ToolContractViolation | undefined {
  // ── type ────────────────────────────────────────────────────────────────
  const expectedType = schema['type']
  if (typeof expectedType === 'string' && !typeMatches(expectedType, value)) {
    return violation(phase, path, 'type', `期望 ${expectedType}，实际 ${describeType(value)}`)
  }

  // ── enum ────────────────────────────────────────────────────────────────
  const enumValues = schema['enum']
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => candidate === value)) {
    return violation(phase, path, 'enum', `不在允许取值内：${describeType(value)}`)
  }

  // ── 数值类 ──────────────────────────────────────────────────────────────
  if (typeof value === 'number') {
    const numeric = checkNumber(schema, value)
    if (numeric !== undefined) return violation(phase, path, numeric.code, numeric.detail)
  }

  // ── 字符串类 ────────────────────────────────────────────────────────────
  if (typeof value === 'string') {
    const textual = checkString(schema, value)
    if (textual !== undefined) return violation(phase, path, textual.code, textual.detail)
  }

  // ── 数组 ────────────────────────────────────────────────────────────────
  if (Array.isArray(value)) {
    const itemSchema = schema['items']
    if (isSchema(itemSchema)) {
      for (let index = 0; index < value.length; index += 1) {
        const nested = walk(itemSchema, value[index], child(path, index), phase)
        if (nested !== undefined) return nested
      }
    }
  }

  // ── 对象 ────────────────────────────────────────────────────────────────
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return walkObject(schema, value as Record<string, unknown>, path, phase)
  }

  return undefined
}

function walkObject(
  schema: StructSchema,
  value: Record<string, unknown>,
  path: string,
  phase: ValidatePhase,
): ToolContractViolation | undefined {
  const properties = schema['properties']
  const required = schema['required']

  // required：缺键与"键在但值 undefined"都算缺失（前者是模型的常见错法）
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== 'string') continue
      if (!(key in value) || value[key] === undefined) {
        return violation(phase, child(path, key), 'required', `缺少必填参数 ${key}`)
      }
    }
  }

  if (typeof properties === 'object' && properties !== null) {
    const table = properties as Record<string, unknown>
    for (const [key, subSchema] of Object.entries(table)) {
      if (!isSchema(subSchema)) continue
      if (!(key in value)) continue
      const nested = walk(subSchema, value[key], child(path, key), phase)
      if (nested !== undefined) return nested
    }

    // additionalProperties: false —— 多传字段即失败。
    // 为什么要支持：模型爱"顺手多塞一个字段"，不拦就会被工具体静默忽略，
    // 而模型会以为自己传对了（幻觉防护的反面）。
    if (schema['additionalProperties'] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in table)) {
          return violation(phase, child(path, key), 'additional-property', `不允许的参数 ${key}`)
        }
      }
    }
  }

  return undefined
}

function checkNumber(
  schema: StructSchema,
  value: number,
): { code: string; detail: string } | undefined {
  const minimum = schema['minimum']
  if (typeof minimum === 'number' && value < minimum) {
    return { code: 'minimum', detail: `不得小于 ${String(minimum)}` }
  }
  const maximum = schema['maximum']
  if (typeof maximum === 'number' && value > maximum) {
    return { code: 'maximum', detail: `不得大于 ${String(maximum)}` }
  }
  const exclusiveMinimum = schema['exclusiveMinimum']
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) {
    return { code: 'exclusive-minimum', detail: `必须大于 ${String(exclusiveMinimum)}` }
  }
  const exclusiveMaximum = schema['exclusiveMaximum']
  if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) {
    return { code: 'exclusive-maximum', detail: `必须小于 ${String(exclusiveMaximum)}` }
  }

  // multipleOf：金额"最多两位小数"靠 `multipleOf: 0.01` 表达（TC-W03-02 ④）。
  // 浮点比较用容差：`19.99 / 0.01 === 1998.9999999999998`。
  const multipleOf = schema['multipleOf']
  if (typeof multipleOf === 'number' && multipleOf > 0) {
    const quotient = value / multipleOf
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      return { code: 'multiple-of', detail: `必须是 ${String(multipleOf)} 的整数倍` }
    }
  }

  return undefined
}

function checkString(
  schema: StructSchema,
  value: string,
): { code: string; detail: string } | undefined {
  const minLength = schema['minLength']
  if (typeof minLength === 'number' && value.length < minLength) {
    return { code: 'min-length', detail: `长度不得小于 ${String(minLength)}` }
  }
  const maxLength = schema['maxLength']
  if (typeof maxLength === 'number' && value.length > maxLength) {
    return { code: 'max-length', detail: `长度不得大于 ${String(maxLength)}` }
  }
  const pattern = schema['pattern']
  if (typeof pattern === 'string') {
    // 坏正则不静默放行：schema 是我们自己写的，写错了要立刻看见
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch {
      return { code: 'pattern-invalid', detail: `schema 的 pattern 不合法：${pattern}` }
    }
    if (!regex.test(value)) {
      return { code: 'pattern', detail: `不匹配 ${pattern}` }
    }
  }
  return undefined
}

/** 粗判"这是个 schema 对象"。 */
function isSchema(value: unknown): value is StructSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只用于错误文案，**不回显值本体**（PII 纪律，宪法 §4）。 */
function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'non-finite number'
  return typeof value
}
