/**
 * `@bah/llm` · 逻辑模块 deepseek（施工单 05 §2.1，子路径导出 `@bah/llm/deepseek`）。
 *
 * `wire.ts` 是纯映射（可无网单测），`adapter.ts` 只做网络与生命周期。
 */

export * from './adapter.ts'
export * from './wire.ts'
