/**
 * 快照录制回放（施工单 12 §3；**阶段 7** 完工）。
 *
 * 已落地：fixture 命名解析 + 同组最高代选择（`fixtures.ts`）——纯文件逻辑，不依赖会话日志，
 * 因此能在阶段 3 之前先落地并先被测试。
 *
 * TODO(阶段 7 · 施工单 12 §4 第 4 步)：`record` / `replay` harness：
 * - 在隔离的 `cwd/sessions/spill` 目录里跑场景；
 * - `record` 录制会话与工作区快照，`replay` **无密钥**回放；
 * - 与 `llm-mock-server` 对接（录制 provider 请求 → 重放响应）；
 * - CI「影响模型可见 / 用户可见的改动必须带快照」检查。
 */
export * from './fixtures.ts'
