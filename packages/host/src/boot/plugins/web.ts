/**
 * `channel:web`：Web 渠道的宿主接线。
 *
 * 分工：**本文件只做声明与生命周期**——装配体已整体平移到 `web/channel.ts` 的
 * `createHttpChannel`，与 `channel:mobile` 共用一份实现。
 * 路由表在 `web/router.ts`（数据，供快照比对），闸的顺序在 `web/dispatch.ts`，
 * 四组处理器在 `web/handlers/*`；`@bah/channels/web` 是事件→帧的纯投影，`apps/web` 是帧→DOM。
 *
 * 为什么是插件行而不是独立 server 脚本：端口/静态目录随部署变化（必须是校验过的 Config 字段）；
 * 渠道要按 `inject` 等 `runtime:session` / `runtime:agents` / `interaction:approval` 就绪
 * （缺审批服务就挂起，不静默降级）；装配与回滚走内核 `effect()`。
 *
 * 端口占用**不自动换端口**：对外说明时浏览器开着 7331、服务却跑到 7332 是最坏的"看起来能用"。
 *
 * W16 拆分：本文件从 916 行降到装配面； 再降到"声明 + 调工厂"，行为零变化——
 * 证据是路由表快照与 `snapshots/web-channel` 回放 diff=0。新增路由必须走路由表，
 * **不许**再往 `apply` 里加 `if`。
 */

import { createWebChannelAdapter } from '@bah/channels'
import { defineService, type ServiceKey } from '@bah/core'
import { APPROVAL_SERVICE } from '@bah/interaction'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { createHttpChannel, type WebServerInfo } from './web/channel.ts'
import { resolveWebSettings, type WebSettings } from './web/config.ts'

/** 配置面再导出（调用方与测试只认 `web.ts`，不认内部文件布局）。 */
export { DEFAULT_WEB } from './web/config.ts'
export type { WebSettings } from './web/config.ts'
/** 服务信息类型再导出（`web/channel.ts` 是定义处）。 */
export type { WebServerInfo } from './web/channel.ts'

/** 服务键：`channel:web`（取服务即证明渠道已就绪）。 */
export const WEB_SERVER: ServiceKey<WebServerInfo> = defineService<WebServerInfo>('channel:web')

export const webPlugin: HostPlugin<WebSettings> = {
  id: 'channel:web',

  plugin: {
    name: 'channel:web',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id, AGENTS_SERVICE.id, APPROVAL_SERVICE.id],

    async apply(ctx, config) {
      await createHttpChannel(ctx, {
        pluginId: 'channel:web',
        channelId: 'web',
        settings: config,
        serverKey: WEB_SERVER,
        adapter: createWebChannelAdapter,
      })
    },
  },

  validate(config) {
    return resolveWebSettings(config)
  },
}
