/**
 * `@bah/bank` · context（实体槽位的数据层，施工单 12 / 实体槽位方案 S2）。
 *
 * 唯一实现：`slots.ts`（读核心 → 选数 → 格式化 → 脱敏 → 超时/熔断 → 预算截断）。
 * 端口由 `bank:tools` 提供、`core:agent` 懒取；本包不 import `@bah/runtime`。
 */
export * from './slots.ts'
