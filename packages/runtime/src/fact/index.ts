/**
 * @bah/runtime · 生活事实库（G3）。
 *
 * 零新事件键：落账走 `fact_remember` / `fact_forget` 的 `tool/call` + `tool/result`；
 * 重启后由 `replayFacts` 重建。
 */
export * from './types.ts'
export * from './store.ts'
export * from './tool.ts'
