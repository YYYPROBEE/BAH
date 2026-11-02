/**
 * 失败 step 的工具结果补记。
 *
 * 问题：step 中途失败（模型取消、超时、异常）时，已经落账的 `tool/call` 可能拿不到
 * `tool/result`，日志就出现空洞——而 `deriveMessages()` 明确把空洞当错误（T-SESS-003）。
 *
 * 解法：主循环订阅 `session/event`，把事件喂给本观察器；catch 分支里取 `results()`
 * 逐条补记（isError）。本类只做**观察与补齐**，不参与判决、不访问 ctx。
 */

import type { AnySessionEvent, ToolCallData, ToolResultData } from '../session/types.ts'

/** 一条待补记的结果。 */
export interface RecoveredToolResult {
  readonly callId: string
  /** 直接可 `session.append('tool/result', data)` 的载荷。 */
  readonly data: ToolResultData
}

export class ToolCallRecovery {
  /** 已观察到的 `tool/call` 且尚未见到 `tool/result` 的调用。 */
  private readonly open = new Map<string, ToolCallData>()

  /** 观察一条会话事件（由 `session/event` 钩子逐条喂入）。 */
  observe(event: AnySessionEvent): void {
    if (event.type === 'tool/call') {
      this.open.set(event.data.callId, event.data)
      return
    }
    if (event.type === 'tool/result') {
      this.open.delete(event.data.callId)
    }
  }

  /**
   * 尚未闭合的调用，全部转成 `isError` 结果（按发现顺序）。
   *
   * @param reason 补记理由（默认说明是 step 中断，便于审计区分「执行失败」与「没来得及执行」）
   */
  results(reason = 'step 中断：工具执行未完成'): readonly RecoveredToolResult[] {
    return [...this.open.values()].map((call) => ({
      callId: call.callId,
      data: {
        callId: call.callId,
        name: call.name,
        isError: true,
        content: [{ type: 'text', text: reason }],
        code: 'tool-interrupted',
        reason,
        durationMs: 0,
      },
    }))
  }

  /** 仍有几条未闭合（调试/断言用）。 */
  get pending(): number {
    return this.open.size
  }
}
