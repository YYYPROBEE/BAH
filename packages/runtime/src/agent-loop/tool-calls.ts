/**
 * 工具调度：模型发起的调用 → 七段管线，以及失败补记的观察口（施工单 04 §2.3 / §6 第 5 步）。
 *
 * 本文件只做三件事，判决与执行语义一律留给 `tools/pipeline.ts`：
 * 1. `ToolCallDispatcher`：把装配后的调用逐个送进七段管线；
 * 2. **参数没能 parse 成 object** 的调用不执行——按三级防线回灌结构化失败
 *    （施工单 05 §2.3 的最后一道），保证 `assistant/message.toolCalls ↔ tool/result` 仍配对；
 * 3. `observeToolCalls`：把 `session/event` 喂给 `ToolCallRecovery`，
 *    让 step 中途失败时能把"已开始、未完成"的调用补记成 `isError`（施工单 03 §0 第 4 条）。
 */

import type { Context, Disposer } from '@bah/core'
import type { AssembledToolCall } from '@bah/llm'

import type { ContentBlock } from '@bah/core'
import type { SessionSink } from '../session/service.ts'
import type { ToolResultData } from '../session/types.ts'
import { ToolCallRecovery } from '../tools/recovery.ts'
import type { ToolPipeline } from '../tools/pipeline.ts'
import type { ToolCallInput, ToolExecution } from '../tools/types.ts'

/** 参数不可用时的理由码（与 `@bah/llm` 的 repair 理由码同源，便于审计聚合）。 */
const INVALID_ARGUMENTS_CODE = 'tool-args-invalid'

/** 一次参数不可用的调用 → 冻结的失败结果（不执行工具体）。 */
export function invalidArgumentsResult(call: AssembledToolCall): ToolResultData {
  const reason =
    call.parseError ?? '参数不是 JSON 对象（工具参数必须以 object 为根）'
  const content: ContentBlock[] = [
    {
      type: 'text',
      text: `工具参数不可用：${reason}\n原文：${call.argsText.length === 0 ? '（空）' : call.argsText}`,
    },
  ]
  return {
    callId: call.callId,
    name: call.name,
    isError: true,
    content,
    code: INVALID_ARGUMENTS_CODE,
    reason,
    durationMs: 0,
  }
}

/** 装配后的调用 → 管线入口形状（`args` 缺省视为无参）。 */
export function toolCallInputOf(call: AssembledToolCall): ToolCallInput {
  return { callId: call.callId, name: call.name, args: call.args ?? {} }
}

/**
 * 取消后**未执行**的调用 → 冻结的失败结果。
 *
 * 必须为每个已声明的 toolCall 落一条 `tool/result`：否则 `deriveMessages` 会判定
 * `tool/call ↔ tool/result` 出现空洞。写操作在入口处挡下（不打断执行中的原子写）。
 */
export function interruptedResult(
  call: AssembledToolCall,
  reason = '用户中断：工具调用未执行',
): ToolResultData {
  return {
    callId: call.callId,
    name: call.name,
    isError: true,
    content: [{ type: 'text', text: reason }],
    code: 'tool-interrupted',
    reason,
    durationMs: 0,
  }
}

/** 调度依赖（管线按 turn 构造：它持有本 turn 的取消信号）。 */
export interface ToolCallDispatcherOptions {
  readonly pipeline: ToolPipeline
  readonly session: SessionSink
}

export class ToolCallDispatcher {
  private readonly pipeline: ToolPipeline
  private readonly session: SessionSink

  constructor(options: ToolCallDispatcherOptions) {
    this.pipeline = options.pipeline
    this.session = options.session
  }

  /**
   * 执行一次调用。
   *
   * 参数不可用（坏 JSON / 根不是 object）→ **不执行**，直接落一条 `isError` 的 `tool/result`：
   * 模型因此知道"这次调用被拒的理由"，下一 step 可以自我修复（施工单 05 §2.3）。
   */
  async execute(call: AssembledToolCall): Promise<ToolExecution> {
    if (call.parseError !== undefined || call.args === undefined) {
      const result = invalidArgumentsResult(call)
      this.session.append('tool/result', result)
      return { result, additionalContexts: [] }
    }
    return this.pipeline.execute(toolCallInputOf(call))
  }

  /**
   * 并行批次准入：参数可解析、绿级只读/无副作用、且本 turn 没有被判 deny。
   *
   * 绿级工具按治理矩阵不会触发 ask，因此“待审批”不会出现在并行批次里；
   * 一旦同指纹已被 deny，必须回到串行路径复用原判决（不能借并发绕开 guard）。
   */
  canRunConcurrently(call: AssembledToolCall): boolean {
    if (call.parseError !== undefined || call.args === undefined) return false
    const input = toolCallInputOf(call)
    return this.pipeline.isReadOnly(call.name) && !this.pipeline.isDenied(input)
  }

  /** 按模型给出的顺序串行执行（工具之间可能有依赖，并发属插件线的显式选择）。 */
  async executeAll(calls: readonly AssembledToolCall[]): Promise<readonly ToolExecution[]> {
    const executions: ToolExecution[] = []
    for (const call of calls) executions.push(await this.execute(call))
    return executions
  }
}

/**
 * 订阅会话事件并喂给失败补记器（step 作用域：主循环在每个 step 开头登记、结束撤销）。
 *
 * 只观察、不干预：`ToolCallRecovery` 不访问 ctx、不改判决，只在 catch 分支被取用。
 */
export function observeToolCalls(ctx: Context, recovery: ToolCallRecovery): Disposer {
  return ctx.events.on('session/event', (envelope) => {
    recovery.observe(envelope.event)
  })
}
