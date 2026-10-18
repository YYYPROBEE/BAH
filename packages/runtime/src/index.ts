/**
 * @bah/runtime 包入口。
 *
 * 已落地：
 * - 阶段 3：沙箱事件声明 `seams.ts`、会话日志 `session/`、工具管线 `tools/`
 * - 阶段 4：提示词装配 `system-prompt/`、上下文压缩 `compaction/`
 * 后续：`agent/`、`agent-loop/`（施工单 04）、`guard/` `plan/` `goal/` `todo/`（施工单 14 / 插件线）。
 */
export * from './compaction/index.ts'
export * from './seams.ts'
export * from './session/index.ts'
export * from './system-prompt/index.ts'
export * from './tools/index.ts'
