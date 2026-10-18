/**
 * 会话模块入口（施工单 03 Part A）。
 *
 * 只在包入口做 re-export：实现分散在 `types.ts` / `store.ts` / `derive.ts` / `service.ts`，
 * 这样覆盖率按文件统计时不会把「只有 re-export 的入口」算进可执行行。
 */
export * from './derive.ts'
export * from './service.ts'
export * from './store.ts'
export * from './types.ts'
