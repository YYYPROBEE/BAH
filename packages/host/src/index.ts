/**
 * @bah/host 包入口（阶段 6：组合系统 + 插件管理）。
 *
 * 逻辑模块子目录（施工单 00 §6）：`src/host/`、`src/client/`、`src/sdk/`（施工单 13 落地）、
 * `src/boot/`、`src/plugin-manager/`（施工单 06，本阶段落地）。
 *
 * 纪律：入口只做 re-export。`boot/index.ts` 已经按需转出 `plugin-manager` 的公开符号，
 * 这里不再重复 `export *`（同名符号会被 TS 判为重复导出）。
 */
export * from './boot/index.ts'
