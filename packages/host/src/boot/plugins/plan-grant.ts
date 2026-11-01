/**
 * 窗口代签核验端口的**服务键**（ADR-0010）。
 *
 * 为什么单独一个文件：
 * - 实现方是 `plan:dag`（它同时看得到 armed store、世界快照、唤醒标记与预算）；
 * - 消费方是 `interaction:approval`（它创建窗口应答者）；
 * - 装配顺序是 `interaction:approval` 先于 `plan:dag`（profile 的行序），
 *   所以消费方**只能在应答时按键懒取**，不能在自己的 `apply` 里 eager `get`。
 *
 * 把键与接口放在这个窄模块里，两边都只依赖两打类型，不互相 import 整个插件。
 */

import { defineService } from '@bah/core'

import type { WindowSignGrant, WindowSignRequest } from '@bah/interaction'

/** 核验端口：一次代签请求 → 放行 / 不放行（不放行 = 应答者沉默，不是拒绝）。 */
export interface WindowSigner {
  sign(request: WindowSignRequest): Promise<WindowSignGrant>
}

/** 服务键：`plan:window-signer`。 */
export const WINDOW_SIGNER = defineService<WindowSigner>('plan:window-signer')
