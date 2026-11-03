/**
 * 快照录制回放。
 *
 * 三块：
 * - `fixtures.ts`：命名解析 + 同组最高代选择（纯文件逻辑）；
 * - `session-log.ts`：会话日志的最小 JSONL 读写（与运行时后端同构，由 snapshots 面交叉验证）；
 * - `harness.ts`：录制 / 读取 / 逐条比对（`session.jsonl` + `llm.jsonl` + `scenario.json`）。
 *
 * 与 `llm-mock-server` 的分工：那边管"provider 请求-响应"的录制回放，这边管"一个场景的快照"。
 * 场景怎么跑起来由调用方提供（不依赖组合系统），所以 harness 也能给插件线用。
 */
export * from './fixtures.ts'
export * from './harness.ts'
export * from './session-log.ts'
