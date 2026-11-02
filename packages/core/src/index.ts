/**
 * @bah/core 包入口（阶段 2：内核实装）。
 *
 * 导出面分两层：
 * - `api.ts` 的冻结契约（阶段 1 签审；本阶段未改动一行）
 * - 实现类与工厂：`createContext` / `BahContext` / `BahEvents` / `BahScope` / `ServiceRegistry` / `defineService`
 *
 * 跨包使用纪律：一律 `import { createContext, defineService } from '@bah/core'`，
 * 不直接 import 另一包的实现类。
 */
export * from './api.ts'

export { BahContext, createContext, type ContextPhase, type RollbackFailure } from './context.ts'
export { CORE_PREFIX, coreError, describeThrown } from './errors.ts'
export { BahEvents, MAX_WATERFALL_DEPTH } from './events.ts'
export { describeUnresolved, erasePlugin, findInjectCycle, findUnknownKeys, resolveConfig } from './plugin.ts'
export { BahScope, createIsolate } from './scope.ts'
export { defineService, ServiceRegistry } from './service.ts'
