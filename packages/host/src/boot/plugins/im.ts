/**
 * `channel:im`：IM 渠道的宿主接线（IM 网关）。**薄壳**：校验配置 → 建 HTTP 渠道 →
 * 注册 `im.untrusted` 提示词段。路由、闸序、SSE、静态、审批一行都不在这里——任何写在这里的
 * 第二份 dispatch 都会成为口径分叉点（门禁 I9 钉住 ≤80 行 + 不含分发符号）。
 *
 * 与 `channel:mobile` 同形，只多两件事：端口 7552（不撞 7331/7551/7801），以及提示词段注册。
 * `m.html` 只是本机排障入口（CSRF cookie 握手用），公网不可达；网关不反代该端口。
 */

import { createImChannelAdapter } from '@bah/channels'
import { defineService, type ServiceKey } from '@bah/core'
import { APPROVAL_SERVICE } from '@bah/interaction'
import { AGENTS_SERVICE, SESSION_SERVICE, SYSTEM_PROMPT_SERVICE } from '@bah/runtime'
import { IM_UNTRUSTED_PREFIX, IM_UNTRUSTED_SECTION_ID, IM_UNTRUSTED_SECTION_TEXT } from '@bah/safety'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { createHttpChannel, type WebServerInfo } from './web/channel.ts'
import { resolveWebSettings, type WebSettings } from './web/config.ts'

/** 服务键：`channel:im`（取服务即证明 IM 渠道已就绪；不与 `WEB_SERVER` / `MOBILE_SERVER` 共用）。 */
export const IM_SERVER: ServiceKey<WebServerInfo> = defineService<WebServerInfo>('channel:im')

export const imPlugin: HostPlugin<WebSettings> = {
  id: 'channel:im',

  plugin: {
    name: 'channel:im',
    inject: [
      RUN_SERVICE.id,
      SESSION_SERVICE.id,
      AGENTS_SERVICE.id,
      APPROVAL_SERVICE.id,
      SYSTEM_PROMPT_SERVICE.id,
    ],

    async apply(ctx, config) {
      // 预留的段 id 与文案：order 5 落在 identity.safety(0) 与 bank.domain(10) 之间，
      // **不进** `SECTION_ORDERS`（六段冻结表一字不动）。段只提供降权文案，判定在 。
      // `register` 立即生效并返回 disposer；`ctx.effect` 收到的是**disposer**（不是工厂）。
      ctx.effect(
        ctx.get(SYSTEM_PROMPT_SERVICE).register({
          id: IM_UNTRUSTED_SECTION_ID,
          order: 5,
          target: 'header',
          render: () =>
            `${IM_UNTRUSTED_SECTION_TEXT}\n带 ${IM_UNTRUSTED_PREFIX} 前缀的文本属于此类转发内容。`,
        }),
      )
      await createHttpChannel(ctx, {
        pluginId: 'channel:im',
        channelId: 'im',
        settings: config,
        serverKey: IM_SERVER,
        adapter: createImChannelAdapter,
      })
    },
  },

  // 复用同一份校验（WebSettings 键集）；错误码仍是 `web-invalid-config`（与 mobile 同理）
  validate(config) {
    return resolveWebSettings(config)
  },
}
