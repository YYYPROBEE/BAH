/**
 * 测试替身：可手动驱动的接缝总线。
 *
 * 行为对齐 `packages/core/src/events.ts` 的两点关键语义（否则测试会给出假绿）：
 * - `waterfall` 是**链式**的：listener 不调 `next` 即短路；
 * - `emit` **不 await** 监听器（这正是 seamBridge 需要内部排队的原因）。
 */

import type { EventSourcePort, SeamListener, SeamNext } from '../../src/adapters/ports.ts'

export class FakeEvents implements EventSourcePort {
  private readonly table = new Map<string, Set<SeamListener>>()

  on(name: string, listener: SeamListener): () => void {
    const listeners = this.table.get(name) ?? new Set<SeamListener>()
    listeners.add(listener)
    this.table.set(name, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.table.delete(name)
    }
  }

  /** 已注册的监听器数量（断言 dispose 是否真的摘掉）。 */
  count(name: string): number {
    return this.table.get(name)?.size ?? 0
  }

  /** 模拟 waterfall：返回链尾值。 */
  async waterfall(name: string, payload: unknown): Promise<unknown> {
    const listeners = [...(this.table.get(name) ?? [])]
    const step = async (index: number, value: unknown): Promise<unknown> => {
      const listener = listeners[index]
      if (listener === undefined) return value
      return listener(value, (nextValue) => step(index + 1, nextValue))
    }
    return step(0, payload)
  }

  /** 模拟 emit：不 await，返回值丢弃。 */
  emit(name: string, payload: unknown): void {
    const passthrough: SeamNext = async (value) => value
    for (const listener of this.table.get(name) ?? []) {
      listener(payload, passthrough)
    }
  }
}
