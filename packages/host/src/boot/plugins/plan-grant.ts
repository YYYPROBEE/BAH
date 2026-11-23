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

import type { ApprovalPreauth, PreauthExpectation, WindowSignGrant, WindowSignRequest } from '@bah/interaction'

/** 核验端口：一次代签请求 → 放行 / 不放行（不放行 = 应答者沉默，不是拒绝）。 */
export interface WindowSigner {
  sign(request: WindowSignRequest): Promise<WindowSignGrant>
}

/** 服务键：`plan:window-signer`。 */
export const WINDOW_SIGNER = defineService<WindowSigner>('plan:window-signer')

/**
 * 窗口**预授权凭据**的核验端口（F-01）。
 *
 * 与 `WindowSigner` 的分工：
 * - `WindowSigner` 决定"这一次代签能不能签"（世界快照、预算、档位）；
 * - 本端口决定"这张红级票据要求的那次强验证，能不能用武装时的凭据抵"。
 *
 * 后者还多一层跨重启语义：武装时的挑战结论在进程内内存里，重启即失；
 * 有签名回执时以回执为准（密钥来自部署环境，不进仓）。
 */
export interface WindowPreauthVerifier {
  /**
   * @returns `true` = 凭据成立（审批服务放行）；`false` = 不成立（落 `challenge-required`）
   */
  verify(preauth: ApprovalPreauth, expectation: PreauthExpectation): boolean
}

/** 服务键：`plan:window-preauth`。 */
export const WINDOW_PREAUTH = defineService<WindowPreauthVerifier>('plan:window-preauth')
