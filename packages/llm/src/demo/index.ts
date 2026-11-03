/**
 * `@bah/llm` · 逻辑模块 demo（子路径导出 `@bah/llm/demo`）。
 *
 * 与 `mock` 的区别只有一条：`mock` 按脚本出队，`demo` **读消息**再规划。
 * 两者共用同一个 `MockLlmAdapter`——分片、确定性、用量上报都不重复实现。
 *
 * 用途：真实模型不可用（无密钥 / 断网 / 限流）时的演示兜底。
 * 它不是"更聪明的 mock"，它只是**不会答非所问**。
 */

import { MockLlmAdapter, MOCK_USAGE } from '../mock/adapter.ts'
import type { MockToolOutcome } from '../mock/script.ts'
import type { CallUsage, ModelSpec } from '../llm/types.ts'

import { planFromRequest } from './router.ts'

export * from './router.ts'

/** 路由模型的规格（能力位与 mock 一致：工具调用 + 推理，无图片）。 */
export const ROUTER_MODEL: ModelSpec = {
  id: 'router-chat',
  providerId: 'router',
  displayName: 'Demo Router（离线意图路由，非磁带）',
  capabilities: { toolCall: true, image: false, reasoning: true },
  contextWindow: 32_000,
}

/** 构造选项。 */
export interface DemoRouterOptions {
  /** 分片大小（字符数；缺省 8）。 */
  readonly chunkSize?: number
  /** 每次模型调用前的演示延迟（ms；缺省 0）。 */
  readonly stepDelayMs?: number
  /** 每步上报的用量（缺省与 mock 一致）。 */
  readonly usage?: CallUsage
  /** 本会话的工具结局（`outcome` / `reflect` 步的依据）。 */
  readonly toolOutcomes?: () => readonly MockToolOutcome[]
}

/**
 * 造一个离线演示适配器。
 *
 * `script` 不传：步骤由 `plan` 按请求现算，所以同一个适配器能回答任意金额、
 * 任意收款人的转账，也能对认不出的问题追问。
 */
export function createDemoRouter(options: DemoRouterOptions = {}): MockLlmAdapter {
  let callSeq = 0
  return new MockLlmAdapter({
    // 每个模型调用一个唯一前缀：同一轮内稳定，跨轮不重复（见 prefixCallIds 的注释）。
    plan: (request) => {
      callSeq += 1
      return planFromRequest(request, `call-${String(callSeq)}`)
    },
    providerId: 'router',
    models: [ROUTER_MODEL],
    usage: options.usage ?? MOCK_USAGE,
    ...(options.chunkSize === undefined ? {} : { chunkSize: options.chunkSize }),
    ...(options.stepDelayMs === undefined ? {} : { stepDelayMs: options.stepDelayMs }),
    ...(options.toolOutcomes === undefined ? {} : { toolOutcomes: options.toolOutcomes }),
  })
}
