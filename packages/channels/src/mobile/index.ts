/**
 * `@bah/channels` · 逻辑模块 mobile。
 *
 * 这里只有移动渠道的**薄工厂**：帧模型、归约器、审批翻译全部复用 `../web/` 与
 * `../http-adapter.ts`（00 D2：安全面只有一份实现）。HTTP / SSE / 静态资源在宿主插件
 * （`@bah/host` 的 `channel:mobile`），DOM 在 `apps/web` 的移动壳（02 单）。
 */

export { MOBILE_CHANNEL_ID, createMobileChannelAdapter } from './adapter.ts'
export type { MobileChannelAdapter } from './adapter.ts'
