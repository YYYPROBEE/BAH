/**
 * headless 自动应答者。
 *
 * 存在的理由：幕 3 要在没有 Web 弹窗的 headless 里跑通「ask → 批准 → 核销」，
 * 而 Web 渠道要到才有。默认配置下这个应答者**不注册**——默认仍是拒绝
 * （无应答者 = `unavailable`），只有 profile 显式写 `responder: headless` 才会装上。
 *
 * 它同时是回归夹具：`decision` / `verifyChallenge` / `delayMs` 三个旋钮覆盖
 * 「驳回」「挑战失败」「慢渠道被快渠道抢先」等竞态场景。
 */

import type { ApprovalResponder, Timer } from './types.ts'
import { systemTimer } from './types.ts'

/** 自动应答者的行为配置。 */
export interface HeadlessResponderOptions {
  /** 结论（缺省 `allowed-once`）。 */
  readonly decision?: 'allowed-once' | 'rejected' | 'cancelled'
  /** 理由（拒绝 / 取消时落审计）。 */
  readonly reason?: string
  /** 红级是否先走强验证（缺省 true：不验过就批准会被审批服务拒绝）。 */
  readonly verifyChallenge?: boolean
  /** 延迟应答（ms；用于"后到者收到已决"的竞态演练）。 */
  readonly delayMs?: number
  /** 定时器接缝（缺省 `systemTimer`；测试注入手动时钟）。 */
  readonly timer?: Timer
}

/** 渠道 id（审计里的「谁先答的」）。 */
export const HEADLESS_RESPONDER_ID = 'headless-auto'

/**
 * 造一个 headless 自动应答者。
 *
 * 行为：
 * 1. 有挑战且 `verifyChallenge = true` → 先 `challenge.verify()`；
 * 2. 验证失败 → 直接驳回（**批准不可达**，不是"忽略验证继续批"）；
 * 3. 否则按 `decision` 应答；`delayMs > 0` 时经注入定时器延后（可被更快的渠道抢先）。
 */
export function createHeadlessResponder(
  options: HeadlessResponderOptions = {},
): ApprovalResponder {
  const decision = options.decision ?? 'allowed-once'
  const verifyChallenge = options.verifyChallenge ?? true
  const delayMs = options.delayMs ?? 0
  const timer = options.timer ?? systemTimer

  return {
    id: HEADLESS_RESPONDER_ID,

    /**
     * **不认领窗口票据**（ADR-0010）。
     *
     * 自动应答者的语义是"夹具替人点一下"；窗口票据的签署人是授权窗口本身，
     * 它的凭据必须由宿主逐条核验（标记 / 复验 / 档位 / 预算 / 预授权）。
     * 若两者同时注册而自动应答者抢先答了窗口票据，窗口核验就被整条绕过——
     * 那正是本设计要修掉的"无差别放行"。所以这里显式让位。
     */
    accepts: (input) => input.authorization?.kind !== 'window',

    attach(view) {
      const run = async (): Promise<void> => {
        try {
          if (view.challenge !== undefined && verifyChallenge) {
            const verdict = await view.challenge.verify()
            if (!verdict.ok) {
              view.answer({ decision: 'rejected', reason: verdict.reason })
              return
            }
          }
          view.answer({
            decision,
            ...(options.reason === undefined ? {} : { reason: options.reason }),
          })
        } catch {
          // 验证端口抛错 = 渠道不可达：默认拒绝，绝不带着未验证的票据放行
          view.answer({ decision: 'unavailable', reason: 'approval-responder-error' })
        }
      }

      if (delayMs > 0) {
        timer.set(() => {
          void run()
        }, delayMs)
        return
      }
      void run()
    },
  }
}
