/**
 * sentry 判决件的 fail-closed 包装（施工单 HP-0 §3.1）。
 *
 * ## 为什么需要这一层
 *
 * 七段管线对 `tools/post-execute` 的异常处理是"宽容"的（`runtime/src/tools/pipeline.ts`）：
 *
 * ```text
 * 后置监听器坏了不等于工具执行坏了：按 accept 继续，落审计。
 * ```
 *
 * 这条宽容对普通观察者成立，但对**带 block 权限的判决件**是反模式：sentry 的数值对账
 * 一旦自己抛错，未经核验的工具结果会原样作为可信内容交给模型——校验组件失效的那一次，
 * 恰好就是最该拦截的那一次。
 *
 * 本包装只改 sentry 自己的监听器，不动 runtime 的通用 catch：`runtime` 不知道谁"带判决权"，
 * 让它猜哪个监听器重要，等于把职责放到错误的层。
 *
 * ## 三条纪律
 *
 * 1. **不向上抛**：抛出去会落到 runtime 的 `catch`，那条路径返回 accept——正好是我们要避免的；
 * 2. **错误详情不进模型可见文本**：`reason` 是固定话术，错误消息只进审计（截断 200 字），
 *    也不拼接 `payload` / 工具参数 / 工具结果，避免把失败面变成信息泄漏面；
 * 3. **`next` 最多一次**：内层监听器若重复调用下游，会出现"同一结果被下游判决两次"，
 *    这在有副作用的监听器（记账 / 吊销票据）上不是幂等的。
 */

import { reasonOf } from '@bah/util'

import type { TraceLog } from '../kernel/index.ts'

import type { SentrySessionEventType } from './events.ts'
import { createNumericListener, type SentryHonestyOptions } from './honesty.ts'

/** 包装参数：只要落账能力，不要整个 settings。 */
export interface FailClosedOptions {
  readonly sessionId: string
  readonly trace: TraceLog
  readonly record: (type: SentrySessionEventType, data: unknown) => void
  readonly now: () => number
}

/** `tools/post-execute` 监听器形状（与七段管线的 waterfall 一致）。 */
export type PostExecuteListener = (
  payload: unknown,
  next: (value: unknown) => Promise<unknown>,
) => Promise<unknown>

/** 审计里错误消息的截断长度。 */
const MAX_MESSAGE = 200

/** 结构化理由码（模型与审计共用的唯一标识）。 */
export const VERIFIER_UNAVAILABLE = 'verifier-unavailable'

/**
 * 模型可见的固定话术。
 *
 * 刻意不含错误内容：真实原因写在 `sentry/verifier-failed` 与 TraceLog 里，
 * 只给运维看。模型看到"组件异常，已阻断"就够——它既不需要、也不该拿到内部异常。
 */
const BLOCK_REASON =
  '【幻觉防护】结果核验组件异常，本次工具结果未经核验，已阻断。请重试或联系运维。'

/**
 * 把任意 post-execute 监听器包成 fail-closed。
 *
 * @param listener 原始监听器（正常路径完全由它决定）
 * @param options 落账依赖
 * @returns 包装后的监听器：**永不抛错**，异常一律降级为 `block`
 */
export function failClosedPostExecute(
  listener: PostExecuteListener,
  options: FailClosedOptions,
): PostExecuteListener {
  const { sessionId, trace, record, now } = options

  return async (payload, next) => {
    // 一次取用：内层无论调几次 `next`，下游只跑一次
    const once = onceNext(next)
    try {
      return await listener(payload, once)
    } catch (error) {
      const at = now()
      const message = truncate(reasonOf(error), MAX_MESSAGE)
      trace.append({ session: sessionId, kind: 'honesty-verifier-failed', message, at })
      record('sentry/verifier-failed', {
        listener: 'tools/post-execute',
        code: VERIFIER_UNAVAILABLE,
        message,
        at,
      })
      return {
        ...(isRecord(payload) ? payload : {}),
        verdict: { kind: 'block', code: VERIFIER_UNAVAILABLE, reason: BLOCK_REASON },
      }
    }
  }
}

/**
 * sentry 自己的 post-execute 监听器：数值对账 + fail-closed。
 *
 * `createNumericListener` 保留导出与既有测试不动（接口已冻结），这里只做包装。
 */
export function createSentryPostExecuteListener(
  options: SentryHonestyOptions,
): PostExecuteListener {
  return failClosedPostExecute(createNumericListener(options), {
    sessionId: options.sessionId,
    trace: options.trace,
    record: options.record,
    now: options.now,
  })
}

/**
 * `next` 的一次性包装。
 *
 * 同步抛错**不在这里转成 reject**：让它按普通异常冒泡到内层监听器的调用点，
 * 最终由本层的 catch 接住。若这里转成 `Promise.reject`，内层不 await 它就会
 * 变成 unhandled rejection——用更隐蔽的方式报告同一个错误，不值。
 */
function onceNext(next: (value: unknown) => Promise<unknown>): (value: unknown) => Promise<unknown> {
  let cached: Promise<unknown> | undefined
  return (value) => {
    if (cached === undefined) cached = next(value)
    return cached
  }
}

/** 截断到 `limit` 字符（按码点，不切坏代理对）。 */
function truncate(text: string, limit: number): string {
  const chars = [...text]
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
