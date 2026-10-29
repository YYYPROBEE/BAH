/**
 * @bah/runtime · goal 平面（04 单）。
 *
 * 状态封闭联合 + 确定性 store + 重放重建 + 内置绿级工具 `goal_set`。
 * 零新事件键：所有落账走 `tool/call` + `tool/result`（D5/D8）。
 */
export * from './types.ts'
export * from './store.ts'
export * from './tool.ts'
