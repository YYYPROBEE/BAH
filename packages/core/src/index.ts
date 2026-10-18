/**
 * @bah/core 包入口（M0，阶段 1）。
 *
 * 本阶段只导出 `api.ts` 里已冻结的内核契约；
 * 阶段 2 起，`context.ts` / `events.ts` / `service.ts` / `plugin.ts` / `scope.ts`
 * 的实现才从这里补齐导出，且实现必须满足 api.ts 的形状（改动走破坏性变更流程）。
 */
export * from './api.ts'
