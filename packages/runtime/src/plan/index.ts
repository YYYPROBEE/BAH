/**
 * `@bah/runtime` · 逻辑模块 plan（`plan:dag` 的纯引擎）。
 *
 * 边界（方案 §0.3 硬约束 2）：本目录**不 import 任何宿主包**——
 * 没有 `@bah/host` / `@bah/bank` / `ToolPipeline`。唯一的宿主依赖是 `PlanInvoker` 函数签名。
 *
 * 文件职责：
 * - `types.ts`：数据结构 + 常量（无逻辑）；
 * - `topo.ts`：Kahn 拓扑序 + 环路径；
 * - `validate.ts`：10 条校验（返回问题，不抛）；
 * - `machine.ts`：9 态转移表；
 * - `template.ts`：动态 args 的模板解析与替换（`"${node.<id>.<path>}"`）；
 * - `events.ts`：8 个 durable 事件（只声明）+ 重放读入的最小形状；
 * - `engine.ts`：状态驱动 / 传播 / 取消 / 快照 / 重放 / 续跑。
 */

export * from './engine.ts'
export * from './events.ts'
export * from './machine.ts'
export * from './template.ts'
export * from './topo.ts'
export * from './types.ts'
export * from './validate.ts'
