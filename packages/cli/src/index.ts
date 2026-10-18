/**
 * @bah/cli 包入口（阶段 6：profile 组合 + 底座出口）。
 *
 * 逻辑模块子目录（施工单 00 §6）：`src/cli/`。
 * `bundle-*` 是**数据**（`bundles/<name>/index.ts` + patch 文件），不是本入口的导出面。
 */
export * from './bundles.ts'
export * from './cli/index.ts'
export * from './dump-config.ts'
export * from './profile.ts'
