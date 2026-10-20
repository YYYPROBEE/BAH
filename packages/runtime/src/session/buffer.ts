/**
 * 会话写入缓冲（P-P4 只读工具并行）。
 *
 * 并行的 green 调用各自在 `AsyncLocalStorage` 缓冲里跑：会话 append / 领域事件 /
 * `tools/result` 都不立刻写真实日志。批次结束后按**模型给出的调用顺序**逐条 flush，
 * 因此 durable 事件序与串行执行完全一致。
 *
 * 只读工具不会走审批，所以这里不缓冲 `approval/request` 之类的 waterfall 副作用。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import type { SessionSink } from './service.ts'
import type { ToolResultData } from './types.ts'

type BufferedOp =
  | { readonly kind: 'append'; readonly run: (sink: SessionSink) => unknown }
  | { readonly kind: 'emit-result'; readonly result: ToolResultData }

export class SessionEventBuffer {
  private readonly ops: BufferedOp[] = []

  /** 记录一次会话写入；`run` 在 flush 时对真实 sink 执行。 */
  record(run: (sink: SessionSink) => unknown): void {
    this.ops.push({ kind: 'append', run })
  }

  /** 记录一次 `tools/result` 广播（flush 时按原顺序 emit）。 */
  emitResult(result: ToolResultData): void {
    this.ops.push({ kind: 'emit-result', result })
  }

  /** 按记录顺序写入真实会话并广播结果。 */
  flush(sink: SessionSink, emitResult: (result: ToolResultData) => void): void {
    for (const op of this.ops) {
      if (op.kind === 'append') op.run(sink)
      else emitResult(op.result)
    }
    this.ops.length = 0
  }
}

const storage = new AsyncLocalStorage<SessionEventBuffer>()

/** 当前异步上下文是否处于缓冲模式。 */
export function currentSessionBuffer(): SessionEventBuffer | undefined {
  return storage.getStore()
}

/** 在该缓冲内执行（`await` 链上的所有会话写入都会被记录）。 */
export function withSessionBuffer<T>(buffer: SessionEventBuffer, run: () => Promise<T>): Promise<T> {
  return storage.run(buffer, run)
}
