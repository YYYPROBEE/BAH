/**
 * @bah/runtime 包入口。
 *
 * 已落地：
 * - 阶段 3：沙箱事件声明 `seams.ts`、会话日志 `session/`、工具管线 `tools/`
 * - 阶段 4：提示词装配 `system-prompt/`、上下文压缩 `compaction/`
 * - 阶段 5：主循环 `agent-loop/`、agent 接口与活体注册表 `agent/`
 * - 插件线：编排原语 `plan/`（`plan:dag` 的纯引擎，宿主装配在 `@bah/host`）
 * - 04 单：`goal/`（意图账本）、`todo/`（plan 事件的派生清单）
 * 后续：`guard/`（施工单 14 / 插件线）。
 */
export * from './agent/index.ts'
export * from './agent-loop/index.ts'
export * from './compaction/index.ts'
export * from './goal/index.ts'
export * from './intent/index.ts'
export * from './plan/index.ts'
export * from './todo/index.ts'
export * from './policy/index.ts'
export * from './seams.ts'
export * from './session/index.ts'
export * from './system-prompt/index.ts'
export * from './tools/index.ts'
