/**
 * @bah/channels 包入口。
 *
 * 逻辑模块子目录：
 * - `src/web/`：Web 渠道适配器与投影
 * - `src/mobile/`：移动 H5 渠道的薄工厂
 * - `src/desktop/`：桌面渠道的薄工厂
 * - `src/im/`：IM 渠道内核（平台契约 / 会话键 / 帧投影 / 指令，IM 网关 01）
 *
 * 依赖方向：`@bah/host` 组装渠道（`channel:web` / `channel:mobile` 插件持有 HTTP / SSE），
 * 本包只做纯转换，**不反向依赖宿主**（否则 `tsc -b` 成环，见 docs/web-frontend.md §3）。
 *
 * ：契约层先于渠道层导出——`import { MOBILE_CAPABILITIES } from '@bah/channels'`
 * 不该牵动 web 子树；`package.json` 的 `exports` 维持只有 `"."`（单入口打包，不加子路径）。
 */

export * from './capabilities.ts'
export * from './http-adapter.ts'
export * from './web/index.ts'
export * from './mobile/index.ts'
export * from './desktop/index.ts'
export * from './im/index.ts'
