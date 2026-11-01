/**
 * 窗口代签应答者（ADR-0010）：**只在票据自带 `authorization.kind === 'window'`
 * 且宿主核验端口放行时**回一句 `allowed-once`，其余一切情况**一个字都不答**。
 *
 * ## 为什么它必须"沉默"而不是"拒绝"
 *
 * 审批服务是「先到者胜出」：谁先 `answer()` 谁就把结论钉死。
 * 一个会在条件不成立时 `reject` 的应答者，会把本该由人处理的票据**抢答成拒绝**——
 * 用户点开审批卡时票据已经死了。所以失败路径只能是 `return`：
 * 把票据留给渠道 / 超时（超时 = `unavailable` = 拒绝，方向仍是对的）。
 *
 * ## 为什么它不能只看 `authorization` 字段
 *
 * `authorization` 是**声明**，不是**证明**。伪造面有两个：
 * 1. 页面/模型路径：Web 渠道永远拿不到这个字段（`TicketAuthorization` 只由管线从
 *    受控执行器的 `runAuthorization` 注入），但"拿不到"不等于"伪造不了"——
 *    多监听一个 `tools/pre-execute` 就能往 ask 判决里塞一份；
 * 2. 本进程内的其它插件：它们能读到同一个 `bah:run`。
 *
 * 所以真正的判据在宿主的 `verifyWindow`：它必须同时看到
 * ①**唤醒执行器为这次 run 开的一次性标记**（`windowId` + `planId` + `digest` + 预算）
 * ②票据 `authorization.ref` 指向同一个窗口，③窗口复验与档位/预算/预授权逐条成立。
 * 本文件只做"要不要问"和"问到了怎么答"，一条判定规则都不在这里。
 *
 * 纪律：不读真实时钟、不读随机（本文件没有时间与随机源，全量来自入参）。
 */

import type {
  ApprovalAnswer,
  ApprovalResponder,
  ApprovalView,
  AuthorizationRef,
} from './types.ts'

/** 渠道 id（进 `approval/decided.by`；这是"谁签的字"的唯一出处）。 */
export const WINDOW_RESPONDER_ID = 'window-responder'

/**
 * 生效级别（只分两档，**不猜**）。
 *
 * 依据：`requiresChallenge(level) === (level === 'red')`（`bank/src/tools/tier.ts`），
 * 而审批服务只有在红级 ask 上才签发挑战句柄。因此
 * 「有挑战句柄」⇔「生效级别红」，「无挑战」⇔「黄」（绿级根本不会进审批）。
 * 这条等价关系直接复用了治理面的判定，不在审批面重算一遍档位。
 */
export type SignedLevel = 'yellow' | 'red'

/** 一次代签的核验请求（宿主实现 `WindowSigner` 时收到的东西）。 */
export interface WindowSignRequest {
  /** 票据 ID（审计对齐用）。 */
  readonly ticketId: string
  /** 调用 ID（审计对齐用）。 */
  readonly callId: string
  /** 工具名。 */
  readonly name: string
  /** 生效级别（见 {@link SignedLevel}）。 */
  readonly level: SignedLevel
  /** 本次涉及金额（元；无金额工具缺省 0）。 */
  readonly amountYuan: number | undefined
  /** 票据自带的授权来源（`kind` 恒为 `window`）。 */
  readonly authorization: AuthorizationRef
}

/** 核验结论：`ok:false` 一律"不回答"，**不是**"拒绝"。 */
export type WindowSignGrant =
  | { readonly ok: true; readonly windowId: string }
  | { readonly ok: false; readonly code: string; readonly reason?: string }

/** 窗口应答者的依赖（`verifyWindow` 由宿主提供；测试可注入纯函数）。 */
export interface WindowResponderDeps {
  /**
   * 核验端口。
   *
   * 允许异步（宿主需要读世界快照：余额 / 事实版本）。
   * **抛错按不放行处理**——不可自证就不签字。
   */
  readonly verifyWindow: (
    request: WindowSignRequest,
  ) => WindowSignGrant | Promise<WindowSignGrant>
  /** 渠道 id 覆盖（缺省 {@link WINDOW_RESPONDER_ID}；只给多窗口演练用）。 */
  readonly id?: string
}

/** 从审批视图推生效级别（见 {@link SignedLevel} 的等价关系）。 */
export function levelOf(view: ApprovalView): SignedLevel {
  if (view.challenge !== undefined) return 'red'
  // 声明级别是红但治理面没签挑战：按红处理（只会更严）
  return view.summary.tier === 'red' ? 'red' : 'yellow'
}

/**
 * 造一个窗口代签应答者。
 *
 * 行为（顺序即安全边界）：
 * 1. `view.authorization?.kind !== 'window'` → 直接返回（人工票据交给渠道）；
 * 2. 调 `verifyWindow`：非 `ok` → 直接返回（**不 reject**）；
 * 3. 端口抛错 → 直接返回（不回答 = 交给超时，方向仍是拒绝）；
 * 4. 票据已被别的渠道答掉（`signal.aborted`）→ 不再提交；
 * 5. 只有走到这里才 `answer({decision:'allowed-once', reason:'window-authorized'})`。
 */
export function createWindowResponder(deps: WindowResponderDeps): ApprovalResponder {
  const id = deps.id ?? WINDOW_RESPONDER_ID

  return {
    id,

    // 只认领窗口票据：不认领 = 这张票据与没注册应答者等价（立即 `approval-no-responder`），
    // 不会把它拖进 120s 的等 TTL 假等待。
    accepts: (input) => input.authorization?.kind === 'window',

    async attach(view) {
      const authorization = view.authorization
      if (authorization === undefined || authorization.kind !== 'window') return

      const request: WindowSignRequest = {
        ticketId: view.ticketId,
        callId: view.callId,
        name: view.name,
        level: levelOf(view),
        amountYuan: view.summary.amount,
        authorization,
      }

      let grant: WindowSignGrant
      try {
        grant = await deps.verifyWindow(request)
      } catch {
        // 核验端口自身坏了：不回答（不把"核验不了"翻译成"用户拒绝"）
        return
      }
      if (!grant.ok) return
      // 等核验的这段时间里可能已被别的渠道答掉：后到者不提交（避免 duplicate 噪音）
      if (view.signal.aborted) return

      const answer: ApprovalAnswer = {
        decision: 'allowed-once',
        reason: 'window-authorized',
      }
      view.answer(answer)
    },
  }
}
