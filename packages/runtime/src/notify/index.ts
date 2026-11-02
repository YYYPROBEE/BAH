/**
 * @bah/runtime · 打扰策略（G6）。
 *
 * 纯函数 `deriveNotify`：三档重要度 + 日上限 + 静默时段 + 去重。
 * 计数从事件派生的发送历史里数，不落账（第二个真相源一定漂移）。
 */
export * from './policy.ts'
