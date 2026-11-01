/**
 * base bundle · `interaction:approval`：审批服务的宿主接线。
 *
 * 为什么接线在 host 而不是 interaction：
 * 1. `@bah/interaction` 不依赖银行领域，强验证端口（`bank:challenge`）只有宿主能同时看到两边；
 * 2. 审批事件对由七段管线落账，本行只提供**仲裁器**（应答者 / 超时 / 归一化）；
 * 3. 默认配置 `responder: none` —— 没有应答者 = `unavailable` = 拒绝，绝不默认放行。
 *
 * **装配顺序**：本行必须排在 `bank:tools` 之后（waterfall 注册顺序 = 外层顺序：
 * bank 先签五绑定票据，再把"找谁应答"交给本行的仲裁器），也依赖它提供的 `bank:challenge`。
 *
 * 渠道（Web 弹窗 / IM 卡片 / 坐席控制台）落地时只需
 * `ctx.get(APPROVAL_SERVICE).attach(responder)`，不改本文件。
 */

import { BANK_CHALLENGE } from '@bah/bank'
import {
  APPROVAL_SERVICE,
  ApprovalService,
  createHeadlessResponder,
  createWindowResponder,
} from '@bah/interaction'
import type { ApprovalInputLike, WindowSignGrant, WindowSignRequest } from '@bah/interaction'
import { SESSION_SERVICE } from '@bah/runtime'
import { assertNever } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { readBoolean, readEnum, readPositiveInteger, rejectUnknownKeys } from '../config.ts'
import { WINDOW_SIGNER } from './plan-grant.ts'

/** 自动应答策略（只在 `responder: headless` 时生效）。 */
export type AutoDecision = 'allow' | 'reject' | 'cancel'

/** `interaction:approval` 的配置。 */
export interface ApprovalSettings {
  /** 应答者：`none`（默认拒绝）或 `headless`（演示 / 回归的自动应答者）。 */
  readonly responder: 'none' | 'headless'
  /** 自动应答的结论。 */
  readonly autoDecision: AutoDecision
  /** 红级是否先走强验证（默认 true；false 时批准会被审批服务拒绝）。 */
  readonly autoVerify: boolean
  /** 自动应答延迟（ms；缺省 0 = 立即）。 */
  readonly autoDelayMs?: number
  /**
   * 是否注册**窗口代签应答者**（ADR-0010；缺省 false）。
   *
   * 与 `responder` 正交：`responder: none` + `windowResponder: true` 是
   * 「没有自动放行，但到期唤醒的窗口票据可以代签」——这正是 plan / web-plan /
   * subscription / headless 四个 profile 现在要的语义。
   */
  readonly windowResponder: boolean
}

/**
 * 默认配置：**默认拒绝**（W04 起 `autoDecision` 缺省为 `reject`）。
 *
 * 演示 / 回归要批准必须在 profile 里**显式**写 `autoDecision: allow`——
 * 「没配置 = 自动放行」是最容易被忽略的一条放行通道。
 */
export const DEFAULT_APPROVAL: ApprovalSettings = {
  responder: 'none',
  autoDecision: 'reject',
  autoVerify: true,
  windowResponder: false,
}

/** 允许的应答者。 */
const RESPONDERS = ['none', 'headless'] as const

/** 允许的自动结论。 */
const AUTO_DECISIONS = ['allow', 'reject', 'cancel'] as const

export const approvalPlugin: HostPlugin<ApprovalSettings> = {
  id: 'interaction:approval',

  plugin: {
    name: 'interaction:approval',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)

      const service = new ApprovalService({
        sessionId: run.sessionId,
        now: run.now,
        // 银行侧提供的强验证端口（红级挑战链）
        challenges: ctx.get(BANK_CHALLENGE),
        record: (record) => {
          session.appendDomain(record.type, record.data, { ignorable: true })
        },
      })

      if (config.responder === 'headless') {
        service.attach(
          createHeadlessResponder({
            decision: toResponderDecision(config.autoDecision),
            ...(config.autoDecision === 'allow' ? {} : { reason: `headless-${config.autoDecision}` }),
            verifyChallenge: config.autoVerify,
            ...(config.autoDelayMs === undefined ? {} : { delayMs: config.autoDelayMs }),
          }),
        )
      }

      if (config.windowResponder) {
        service.attach(
          createWindowResponder({
            // ★ 懒取核验端口：`plan:dag` 在本行**之后**装配（profile 行序），
            //   eager `ctx.get` 会在载入期抛 `service-missing`。
            //   取不到 = 本 profile 没装 plan:dag ⇒ 不放行（fail-closed）。
            verifyWindow: (request) => verifyWindow(ctx, request),
          }),
        )
      }

      ctx.effect(ctx.provide(APPROVAL_SERVICE, service))
      // 会话关闭时把在途审批归一化为 cancelled（默认拒绝方向）
      ctx.effect(() => {
        service.dispose()
      })
      ctx.effect(
        ctx.events.on('approval/request', (payload, next) => {
          const input = payload as unknown as ApprovalInputLike
          const advance = next as unknown as (value: ApprovalInputLike) => Promise<ApprovalInputLike>
          return service.handle(input, advance)
        }),
      )
    },
  },

  validate(config) {
    rejectUnknownKeys(
      config,
      ['responder', 'autoDecision', 'autoVerify', 'autoDelayMs', 'windowResponder'],
      'interaction:approval',
    )
    const autoDelayMs = readPositiveInteger(config, 'autoDelayMs', 'interaction:approval')
    return {
      responder:
        readEnum(config, 'responder', 'interaction:approval', RESPONDERS) ?? DEFAULT_APPROVAL.responder,
      autoDecision:
        readEnum(config, 'autoDecision', 'interaction:approval', AUTO_DECISIONS) ??
        DEFAULT_APPROVAL.autoDecision,
      autoVerify: readBoolean(
        config,
        'autoVerify',
        'interaction:approval',
        DEFAULT_APPROVAL.autoVerify,
      ),
      windowResponder: readBoolean(
        config,
        'windowResponder',
        'interaction:approval',
        DEFAULT_APPROVAL.windowResponder,
      ),
      ...(autoDelayMs === undefined ? {} : { autoDelayMs }),
    }
  },
}

/**
 * 把窗口应答者的核验请求转给 `plan:dag` 提供的端口。
 *
 * 三个 fail-closed 分支：端口不在（没装 plan:dag）、端口抛错、端口返回非 `ok`。
 * 三者都只是"不回答"——票据留给渠道或超时，绝不替用户拒绝。
 */
async function verifyWindow(
  ctx: Parameters<HostPlugin['plugin']['apply']>[0],
  request: WindowSignRequest,
): Promise<WindowSignGrant> {
  let signer
  try {
    signer = ctx.get(WINDOW_SIGNER)
  } catch {
    return { ok: false, code: 'window-signer-missing', reason: '本 profile 没有装配 plan:dag' }
  }
  try {
    return await signer.sign(request)
  } catch (error) {
    return {
      ok: false,
      code: 'window-signer-error',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 配置结论 → 应答者结论。 */
function toResponderDecision(value: AutoDecision): 'allowed-once' | 'rejected' | 'cancelled' {
  switch (value) {
    case 'allow':
      return 'allowed-once'
    case 'reject':
      return 'rejected'
    case 'cancel':
      return 'cancelled'
    default:
      // 构造不可达：封闭联合已穷尽（纪律 6 要求收尾）
      /* v8 ignore next */
      return assertNever(value, 'approval-auto-decision')
  }
}
