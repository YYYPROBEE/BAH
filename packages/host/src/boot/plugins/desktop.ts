/**
 * `channel:desktop`：桌面渠道的宿主接线（施工单 15 §2 / 桌面端 01）。**薄壳**：只做
 * "校验配置 → 调 `createHttpChannel`"。路由、闸门、SSE、静态、审批一行都不在这里——
 * 任何写在这里的第二份路由表都会成为口径分叉点（与 mobile 同理：安全面只有一份实现）。
 * 门禁 I9 把这条例钉成机器判据（≤80 行 + 不含分发符号 + 不自建 HTTP 服务）。
 *
 * 与 `channel:web` / `channel:mobile` 的差别**只有**：服务键（`channel:desktop`）与适配器
 * （`createDesktopChannelAdapter`，能力位 `gestureConfirm:true` / `voiceInput:'none'`）。
 *
 * 端口：**没有默认端口**。桌面端由 `profiles/desktop/patch.yml` 写 `port: 0`，OS 分配；
 * 主进程从本插件提供的 `DESKTOP_SERVER` 读实际端口，绝不写死（I-DT-02）。
 */

import { createDesktopChannelAdapter } from '@bah/channels'
import { defineService, type ServiceKey } from '@bah/core'
import { APPROVAL_SERVICE } from '@bah/interaction'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { createHttpChannel, type WebServerInfo } from './web/channel.ts'
import { resolveWebSettings, type WebSettings } from './web/config.ts'

/**
 * 服务键：`channel:desktop`。
 *
 * 取服务即证明桌面渠道已就绪；**不与 `WEB_SERVER` 共用**——桌面主进程必须能确认
 * "我拿到的端口属于桌面渠道"，共用键会让同进程装配两个渠道时取错地址。
 */
export const DESKTOP_SERVER: ServiceKey<WebServerInfo> =
  defineService<WebServerInfo>('channel:desktop')

export const desktopPlugin: HostPlugin<WebSettings> = {
  id: 'channel:desktop',

  plugin: {
    name: 'channel:desktop',
    // 与 webPlugin / mobilePlugin 逐字一致：缺审批服务就挂起，不静默降级
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id, AGENTS_SERVICE.id, APPROVAL_SERVICE.id],

    async apply(ctx, config) {
      await createHttpChannel(ctx, {
        pluginId: 'channel:desktop',
        channelId: 'desktop',
        settings: config,
        serverKey: DESKTOP_SERVER,
        adapter: createDesktopChannelAdapter,
      })
    },
  },

  // 复用同一份校验（含 entry/entries 白名单）：错误码仍是 `web-invalid-config`
  // （与 mobile 同理：同一处非法配置不该报两个码，那是第二份校验的入口）
  validate(config) {
    return resolveWebSettings(config)
  },
}
