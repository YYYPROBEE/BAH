/**
 * 主循环模块入口（施工单 04 Part C）。
 *
 * 实现分散在 `inbox.ts`（认领队列）/ `interrupt.ts`（每 turn 一个 AbortController）/
 * `request.ts`（装配 + 冻结 + 提交）/ `tool-calls.ts`（七段管线接线 + 失败补记）/
 * `rollback.ts`（turn 边界分叉）/ `agent.ts`（状态机）。
 * 本文件只做 re-export：覆盖率按文件统计，逻辑写在入口里会逃过门禁。
 */

export * from './agent.ts'
export * from './inbox.ts'
export * from './interrupt.ts'
export * from './request.ts'
export * from './rollback.ts'
export * from './tool-calls.ts'
