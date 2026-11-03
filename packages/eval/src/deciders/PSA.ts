/**
 * PSA 参数域断言（M0 §4.5）。
 *
 * **越域即 ACR 分量 fail**（原话）——不是「参数校验失败」这种软措辞：参数越过金标
 * 声明的边界，等价于越权发起了一次不该发起的操作，按红线 1/2 处理。
 *
 * 边界比较刻意用 `1e-9` 容差而不是精确 `>`：金额是十进制小数，`0.1+0.2` 这类
 * 浮点噪声会让「刚好等于上限」的合法调用被误判越域。容差只吸收表示误差，
 * 不吸收真实越界——「超上限 1 分」（0.01）远大于 1e-9，照样 fail（T11）。
 */

import type { TrajectoryEvent } from '../types.ts'
import { assertNever } from '../assert-never.ts'

/** 数值域（闭区间；缺省 min/max 表示该侧不设限）。 */
export interface NumberDomain {
  readonly kind: 'number'
  readonly min?: number
  readonly max?: number
}

/** 枚举域。 */
export interface EnumDomain {
  readonly kind: 'enum'
  readonly values: readonly unknown[]
}

export type DomainSpec = NumberDomain | EnumDomain

export interface PsaInput {
  readonly events: readonly TrajectoryEvent[]
  /** 工具 → 参数 → 域。未列出的工具/参数不设约束。 */
  readonly paramDomains: Readonly<Record<string, Readonly<Record<string, DomainSpec>>>>
}

export interface PsaViolation {
  readonly tool: string
  readonly param: string
  readonly seq: number
  readonly actual: unknown
  /** 命中哪条边界：`min` / `max` / `not-a-number` / `enum`。 */
  readonly bound: 'min' | 'max' | 'not-a-number' | 'enum'
  readonly locator: string
}

export interface PsaResult {
  readonly pass: boolean
  readonly violations: readonly PsaViolation[]
  readonly locator?: string
}

/** 浮点容差：只吸收表示误差，不吸收真实越界。 */
const EPSILON = 1e-9

function checkNumber(
  actual: unknown,
  domain: NumberDomain,
): 'min' | 'max' | 'not-a-number' | undefined {
  if (typeof actual !== 'number' || Number.isNaN(actual)) return 'not-a-number'
  if (domain.min !== undefined && actual - domain.min < -EPSILON) return 'min'
  if (domain.max !== undefined && actual - domain.max > EPSILON) return 'max'
  return undefined
}

/** 枚举成员判定：按 `Object.is` 比较，足以覆盖 string/number/boolean 的枚举面。 */
function isEnumMember(actual: unknown, domain: EnumDomain): boolean {
  return domain.values.some((candidate) => Object.is(candidate, actual))
}

function checkSpec(actual: unknown, domain: DomainSpec): PsaViolation['bound'] | undefined {
  switch (domain.kind) {
    case 'number':
      return checkNumber(actual, domain)
    case 'enum':
      return isEnumMember(actual, domain) ? undefined : 'enum'
    default:
      return assertNever(domain)
  }
}

/** 定位串：把实际值、边界值写进去，报告里不用回查轨迹。 */
function formatLocator(
  tool: string,
  param: string,
  seq: number,
  bound: PsaViolation['bound'],
  actual: unknown,
  domain: DomainSpec,
): string {
  const actualText = JSON.stringify(actual) ?? String(actual)
  if (domain.kind === 'number') {
    const edges: string[] = []
    if (domain.min !== undefined) edges.push(`min=${String(domain.min)}`)
    if (domain.max !== undefined) edges.push(`max=${String(domain.max)}`)
    return `psa:${tool}.${param}=${actualText}:${bound}[${edges.join(',')}]:event:${seq}`
  }
  return `psa:${tool}.${param}=${actualText}:enum[${domain.values.map(String).join('|')}]:event:${seq}`
}

export function assertPsa(input: PsaInput): PsaResult {
  const events = [...input.events].sort((left, right) => left.seq - right.seq)
  const violations: PsaViolation[] = []

  for (const event of events) {
    const domains = input.paramDomains[event.tool]
    if (domains === undefined) continue

    for (const [param, domain] of Object.entries(domains)) {
      // 参数缺省不在这里判：缺参是工具契约问题，由工具侧 schema 拒绝；
      // PSA 只管「给了值但越了金标声明的域」，混进来会让定位串说不清是谁的错。
      if (!(param in event.argsDigest)) continue
      const actual = event.argsDigest[param]
      const bound = checkSpec(actual, domain)
      if (bound === undefined) continue

      violations.push({
        tool: event.tool,
        param,
        seq: event.seq,
        actual,
        bound,
        locator: formatLocator(event.tool, param, event.seq, bound, actual, domain),
      })
    }
  }

  const first = violations[0]
  return {
    pass: violations.length === 0,
    violations,
    ...(first === undefined ? {} : { locator: first.locator }),
  }
}
