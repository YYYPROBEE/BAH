/**
 * `channel:web` 的三条事件管线（W16 的 ①②③，02 从 `apply` 搬出）。
 *
 * ## 为什么搬出来
 *
 * `apply` 有 **120 行的结构预算**（`contract.test.ts` 钉死），02 的认证面还要占几行。
 * 这三条管线是"事件 → 帧 / delta / 审批应答者"的纯接线，与生命周期无关，
 * 搬出来不改变任何行为（`web-channel` 快照 diff=0 是判据）。
 *
 * ## 顺序纪律
 *
 * `session/event` 的订阅必须**先于** `llm/stream` 之外的一切？不——两者互不依赖，
 * 但审批应答者要在 `bindPort` 之前注册（HTTP 请求到来时它必须已经就位）。
 */

import { deltaFrame } from '@bah/channels'
import type { ApprovalResponder } from '@bah/interaction'
import type { WebChannelAdapter, WebProjector } from '@bah/channels'

import type { Context } from '@bah/core'

import type { ApprovalService } from '@bah/interaction'

import type { SseHub } from './sse.ts'

/** 接线参数。 */
export interface WirePipelinesOptions {
  readonly ctx: Context
  readonly hub: SseHub
  readonly projector: WebProjector
  readonly adapter: WebChannelAdapter
  readonly approval: ApprovalService
  readonly now: () => number
}

/**
 * 装三条管线（全部走 `ctx.effect`，卸载即反向回收）。
 */
export function wireWebPipelines(options: WirePipelinesOptions): void {
  const { ctx, hub, projector, adapter, approval, now } = options

  // ① 会话事件 → 帧（唯一的实时数据源）
  ctx.effect(
    ctx.events.on('session/event', (payload) => {
      for (const frame of projector.apply(payload.event)) hub.publish(frame)
    }),
  )

  // ② 流式分片 → ephemeral delta（不入日志；断线即丢，权威仍是 assistant/message）
  ctx.effect(
    ctx.events.on('llm/stream', (streamer, next) => {
      const tapped: typeof streamer = async function* (call, signal) {
        for await (const chunk of streamer(call, signal)) {
          if (chunk.kind === 'text-delta') hub.publish(deltaFrame(chunk.text, now()))
          yield chunk
        }
      }
      return next(tapped)
    }),
  )

  // ③ 审批应答者：只登记，结论从 HTTP 提交（人点按钮 → adapter.decide → view.answer）
  const responder: ApprovalResponder = {
    id: 'web',
    attach(view) {
      adapter.attachApproval(view)
    },
  }
  ctx.effect(approval.attach(responder))
}
