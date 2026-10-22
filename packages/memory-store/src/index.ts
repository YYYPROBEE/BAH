/**
 * 公开 API 面（施工文档 §9）——纯 barrel，不含实现。
 *
 * 实现下沉到 `layer.ts`：`plugin.ts` 要 import `createMemoryLayer`，而本文件要
 * re-export 插件形状，实现留在这里就成环。
 */

export {
  createMemoryLayer,
  DEFAULT_MAX_K,
  DEFAULT_SENSITIVITY_CEILING,
  MEMORY_CONTEXT_DECLARATION,
} from './layer.ts'
export type { MemoryLayer, MemoryLayerOptions } from './layer.ts'

export * from './types.ts'

export { RETENTION_BASIS, STATEFUL_PREDICATES, renderMemoryText } from './words.ts'
export type { RetentionBasisRow } from './words.ts'

export { extractCandidates } from './extract/rules.ts'
export { INJECTION_PATTERNS } from './gates/injection.ts'
export type { InjectionPattern } from './gates/injection.ts'
export { planRoute, CROSS_SCENE_MIN_CONFIDENCE } from './read/router.ts'
export type { RoutePlan } from './read/router.ts'
export { applyFilter } from './read/filter.ts'
export type { FilterOutcome, FilterReason } from './read/filter.ts'
export { renderRowText, sourceSceneOf } from './read/render.ts'
export { createMemoryStore } from './store/index.ts'
export type { MemoryStore, MemoryStoreOptions, MemoryUnitRow } from './store/index.ts'
export { ProceduralVault } from './vault/procedural.ts'
export { memoryStorePlugin, MEMORY_STORE_PLUGIN_ID } from './plugin.ts'
export type { MemoryStorePluginShape, MemoryStoreSettings } from './plugin.ts'
