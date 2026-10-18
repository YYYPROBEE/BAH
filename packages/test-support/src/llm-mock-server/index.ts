/**
 * llm-mock-server（施工单 12 §3 / 施工单 05 的 llm-mock）——**阶段 4 / 7 落地**。
 *
 * 职责：录制时记录 provider 请求 → 回放时重放响应（确定性、无密钥）。
 *
 * 现在无法实现的原因（不是偷懒，是依赖未冻结）：
 * - wire 形态（messages / tool_calls / usage）由施工单 05 的 Adapter seam 冻结，模型层是阶段 4；
 * - 「录制 → 回放」两端要与会话日志（阶段 3）和快照 harness（阶段 7）对接。
 *
 * TODO(阶段 4)：随 `@bah/llm` 的 mock provider 一起定 wire fixture 格式（JSON，可读、可 diff）。
 * TODO(阶段 7)：补录制/回放两端 + `snapshots/` 对接 + 对抗用例库（施工单 12 §3.1）六条入库。
 */
export {}
