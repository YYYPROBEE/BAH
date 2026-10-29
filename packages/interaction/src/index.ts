/**
 * @bah/interaction 包入口。
 *
 * 逻辑模块子目录（施工单 00 §6）：`src/approval/`（审批/票据）与
 * `src/prompt/`（追问选择题，03 单落地；点选结果是一条普通用户消息，不走审批通道）。
 */
export * from './approval/index.ts'
export * from './prompt/index.ts'
