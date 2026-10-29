/**
 * @bah/runtime · 授权窗口（G1/G2）。
 *
 * 纯函数：`checkWindow` / `duePlans` / `occurrenceOf` / `nextDueAt`；
 * 账本：`createArmedStore` / `replayArmedPlans`。
 * 不读时钟、不读随机、不写日志（门禁 I16 / I8）。
 */
export * from './types.ts'
export * from './window.ts'
export * from './due.ts'
export * from './recurrence.ts'
export * from './armed.ts'
