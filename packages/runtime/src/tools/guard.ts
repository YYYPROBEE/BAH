/**
 * 单调 guard 与参数指纹。
 *
 * 语义：**一旦某调用被判 `deny`，本 turn 内同名同参调用维持 deny**——
 * 模型不能靠"再问一次"把已经拒绝的操作磨过去。
 *
 * 「身份受保护」的实现方式：guard 实例由管线持有（不进服务注册表、不出现在 ctx 上），
 * 插件既拿不到也改不了它的状态；每 turn 由主循环新建/重置。
 */

import { parameterFingerprint } from '@bah/util'

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
 * 参数指纹：`工具名 + SHA-256(canonicalJson(args)) 前 16 字节`。
 *
 * 用途有三处，必须是同一个函数：票据五绑定、单调 guard 的键、`tool/call` 落账字段。
 * 实现收口在 `@bah/util`：银行包与运行时包各自复制一份，迟早会在字段顺序 /
 * 非有限数处理上分叉。
 */
export function fingerprintOf(call: ToolCallInput): string {
  return parameterFingerprint(call.name, call.args)
}
