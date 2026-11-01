/**
 * `@bah/llm` · 逻辑模块 llm。
 *
 * 本文件只做 re-export（覆盖率按文件统计，re-export 不算可执行行）：
 * - `types.ts`：provider-neutral 词汇表（冻结面）
 * - `registry.ts`：Adapter seam 注册表 + 服务键
 * - `assemble.ts`：流式分片装配（参数整体 parse）
 * - `repair.ts`：参数健壮性三级防线的 ②③
 * - `usage.ts`：成本账本
 * - `route.ts`：降级链
 */

export * from './assemble.ts'
export * from './registry.ts'
export * from './repair.ts'
export * from './route.ts'
export * from './turns.ts'
export * from './types.ts'
export * from './usage.ts'
