/**
 * @bah/channels 包入口（施工单 13 起为真实实现）。
 *
 * 逻辑模块子目录（施工单 00 §6）：
 * - `src/web/`：Web 渠道适配器与投影（施工单 13，已落地）
 * - `src/mobile/`、`src/im/`、`src/desktop/`：施工单 14、15（占位）
 *
 * 依赖方向：`@bah/host` 组装渠道（`channel:web` 插件持有 HTTP / SSE），
 * 本包只做纯转换，**不反向依赖宿主**（否则 `tsc -b` 成环，见 docs/web-frontend.md §3）。
 */

export * from './web/index.ts'
