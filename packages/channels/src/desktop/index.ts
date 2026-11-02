/**
 * `@bah/channels` · 逻辑模块 desktop。
 *
 * 这里只有桌面渠道的**薄工厂**：帧模型、归约器、审批翻译全部复用 `../web/` 与
 * `../http-adapter.ts`（00 D2：安全面只有一份实现）。HTTP / SSE / 静态资源在宿主插件
 * （`@bah/host` 的 `channel:desktop`），DOM 在 `apps/web`（桌面窗加载同一份 index.html）。
 */

export { DESKTOP_CHANNEL_ID, createDesktopChannelAdapter } from './adapter.ts'
export type { DesktopChannelAdapter } from './adapter.ts'
