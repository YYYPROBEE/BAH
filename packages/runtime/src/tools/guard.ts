/**
 * 单调 guard 与参数指纹（施工单 03 §2.3 第 ④ 段、§3 第 8 步）。
 *
 * 语义：**一旦某调用被判 `deny`，本 turn 内同名同参调用维持 deny**——
 * 模型不能靠"再问一次"把已经拒绝的操作磨过去。
 *
 * 「身份受保护」的实现方式：guard 实例由管线持有（不进服务注册表、不出现在 ctx 上），
 * 插件既拿不到也改不了它的状态；每 turn 由主循环新建/重置（施工单 04 §2）。
 */

import type { PreExecuteVerdict } from './types.ts'
import type { ToolCallInput } from './types.ts'

/** deny 判决（`PreExecuteVerdict` 的一个分支）。 */
export type DenyVerdict = Extract<PreExecuteVerdict, { kind: 'deny' }>

export class ToolGuard {
  /** 指纹 → 已生效的 deny 判决。 */
  private readonly denied = new Map<string, DenyVerdict>()

  /** 查询该调用是否已被判 deny（命中即直接沿用原判决，不再走判决链）。 */
  check(fingerprint: string): DenyVerdict | undefined {
    return this.denied.get(fingerprint)
  }

  /** 记录一次 deny（单调：只增不删，直到 `reset()`）。 */
  deny(fingerprint: string, verdict: DenyVerdict): void {
    this.denied.set(fingerprint, verdict)
  }

  /** turn 边界清空（主循环在 `turn/end` 时调用）。 */
  reset(): void {
    this.denied.clear()
  }

  /** 已锁定的 deny 数量（审计/调试用）。 */
  get size(): number {
    return this.denied.size
  }
}

/**
 * 参数指纹：`工具名 + 稳定序列化后的参数`。
 *
 * 用途有三处，必须是同一个函数：票据五绑定、单调 guard 的键、`tool/call` 落账字段。
 * 「稳定」= 对象键递归排序，保证同一份参数（键序不同）得到同一指纹。
 */
export function fingerprintOf(call: ToolCallInput): string {
  return `${call.name}:${stableStringify(call.args)}`
}

/** 键序无关的 JSON 序列化（只处理 JSON 可表达的形态）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')
  return `{${body}}`
}
