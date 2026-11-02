/**
 * `channel:mobile`：移动 H5 渠道的宿主接线。**薄壳**：只做
 * "校验配置 → 调 `createHttpChannel`"。路由、闸门、SSE、静态、审批一行都不在这里——
 * 任何写在这里的第二份 dispatch 都会成为口径分叉点（D2：否则移动端会成为
 * "绕过桌面端加固"的旁路）。门禁 I9 把这条例钉成机器判据（≤80 行 + 不含四个符号名）。
 *
 * 版本（00 D2 /）：默认端口 **7551**——不撞 7331(web)/7801(rag)；
 * 刻意不选 7332（`web/listen.ts` 的注释点名它是"浏览器开着 7331、服务却跑到 7332"
 * 那种最坏的"看起来能用"）。
 */

import { createMobileChannelAdapter } from '@bah/channels'
import { defineService, type ServiceKey } from '@bah/core'
import { APPROVAL_SERVICE } from '@bah/interaction'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { createHttpChannel, type WebServerInfo } from './web/channel.ts'
import { resolveWebSettings, type WebSettings } from './web/config.ts'

/** 服务键：`channel:mobile`（取服务即证明移动渠道已就绪；不与 `WEB_SERVER` 共用）。 */
export const MOBILE_SERVER: ServiceKey<WebServerInfo> = defineService<WebServerInfo>('channel:mobile')

export const mobilePlugin: HostPlugin<WebSettings> = {
  id: 'channel:mobile',

  plugin: {
    name: 'channel:mobile',
    // 与 `webPlugin` 逐字一致：缺审批服务就挂起，不静默降级
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id, AGENTS_SERVICE.id, APPROVAL_SERVICE.id],

    async apply(ctx, config) {
      await createHttpChannel(ctx, {
        pluginId: 'channel:mobile',
        channelId: 'mobile',
        settings: config,
        serverKey: MOBILE_SERVER,
        adapter: createMobileChannelAdapter,
      })
    },
  },

  // 复用同一份校验（含 entry/entries 白名单）；错误码仍是 `web-invalid-config`
  // （两个渠道共用一份校验，新造 `mobile-*` 码会让同一处非法配置报两个码）
  validate(config) {
    return resolveWebSettings(config)
  },
}
