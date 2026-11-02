/**
 * @bah/runtime · 授权窗口（G1/G2）。
 *
 * 纯函数：`checkWindow` / `duePlans` / `occurrenceOf` / `nextDueAt`；
 * 代签规则：`WINDOW_AUTO_LEVEL` / `decideWindowSign`（ADR-0010：档位 × 级别 × 预算）；
 * 账本：`createArmedStore` / `replayArmedPlans`。
 * 不读时钟、不读随机、不写日志（门禁 I16 / I8）。
 */
export * from './types.ts'
export * from './window.ts'
export * from './sign.ts'
export * from './due.ts'
export * from './recurrence.ts'
export * from './armed.ts'
