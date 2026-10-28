/**
 * `channel:web` 处理器的依赖面（W16 新建）。
 *
 * 为什么是显式依赖对象而不是继续用闭包：拆分前四个 handler 都是 `apply()` 里的闭包，
 * 好处是"什么都能拿"，代价是**没人说得清一个 handler 到底依赖了什么**——916 行里有
 * 622 行都是一个函数的闭包。依赖面写进接口后，`apply()` 只剩装配，处理器可单测。
 *
 * 纪律：`handlers/` 只 import 本文件与 `../http.ts` 这类叶子模块，**不许反向 import
 * `web.ts`**（TC-W16-08；反向 import 会把 web.ts → dispatch → handler → web.ts 连成环）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebChannelAdapter } from '@bah/channels'
import type { Context, ServiceKey } from '@bah/core'
import type { Agent, SessionApi } from '@bah/runtime'
import type { HaltHandle, SentryHandle } from '@bah/safety'

import type { HandoffHandle } from './handoff.ts'
import type { createRateLimiter } from '../web-rate-limit.ts'
import type { Principal } from '../web-operator.ts'
import type { SseHub } from './sse.ts'

/** 限流器实例类型（`createRateLimiter` 的返回，不另立接口）。 */
export type RateLimiter = ReturnType<typeof createRateLimiter>

/** 处理一个请求需要的全部外部状态（构造于 `apply()`，生命周期 = 插件实例）。 */
export interface WebDeps {
  /** 会话服务（读 `sessionId` / `lastSeq` / `events`）。 */
  readonly session: SessionApi
  /** 审批 / 强验证的传输层（归属校验在适配器里）。 */
  readonly adapter: WebChannelAdapter
  /** SSE 广播与连接管理。 */
  readonly hub: SseHub
  /** 本进程的 Web 访问凭证（未配置时随机生成，绝不写死）。 */
  readonly webToken: string
  /** 坐席凭证（未配置时 undefined ⇒ `auth:'operator'` 路由一律 404）。 */
  readonly operatorToken: string | undefined
  /** 坐席显示名（`BAH_OPERATOR_NAME`，缺省 `坐席`）。 */
  readonly operatorName: string
  /** 本进程的 CSRF 令牌（index 下发 cookie，前端回填请求头）。 */
  readonly csrfToken: string
  /** 每个来源的固定窗口限流。 */
  readonly rateLimiter: RateLimiter
  /** 注入钟（落帧时间戳与心跳注释都用它，禁 `Date.now()`）。 */
  readonly now: () => number
  /** 取唯一活体 agent（profile 里只有一个 `core:agent`）。 */
  readonly firstAgent: () => Agent | undefined
  /** 首次提交时懒启动常驻驱动（headless 测试不会因空转挂住）。 */
  readonly ensureDriver: (agent: Agent) => void
  /** 惰性取 sentry（不进 `inject`，否则无 sentry 的 profile 起不来）。 */
  readonly trySentry: () => SentryHandle | undefined
  /** 惰性取 HALT（同上）。 */
  readonly tryHalt: () => HaltHandle | undefined
  /**
   * 人工接管状态机（C5）。状态落 `<root>/<sid>/handoff.json`；
   * 同 `--session` 重启恢复接管状态，但 boot 不重放历史会话（见 `handoff.ts`）。
   */
  readonly handoff: HandoffHandle
  /** 已解析的静态根（绝对路径）。 */
  readonly staticRoot: string
  /** 静态根下的 index.html（token 与 CSRF cookie 的唯一载体）。 */
  readonly indexPath: string
  /** 静态根下的 operator.html（坐席入口；**零注入**，文件不存在则 404）。 */
  readonly operatorIndexPath: string
}

/** 解析好的请求行（避免每个 handler 各自 `new URL` 一遍）。 */
export interface WebRequest {
  readonly method: string
  readonly url: URL
  readonly path: string
  /** 前缀路由的尾段（`/api/approval/t-1` → `t-1`）；其余为空串。 */
  readonly rest: string
  /**
   * 出示凭证的身份（dispatch 判定；`auth:'public'` 路由不填）。
   *
   * 不放 `deps` 上：`deps` 的生命周期是插件实例，`principal` 是一条请求——
   * 混在一起就会出现"上一个请求的身份泄漏给下一个"。
   */
  readonly principal?: Principal
}

/** 处理器签名（4 个 handler 模块统一，dispatch 查表调用）。 */
export type WebHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
) => Promise<void>

/**
 * 惰性取服务（缺省返回 `undefined`，不抛）。
 *
 * **不能**把 `SENTRY_SERVICE.id` / `HALT_SERVICE.id` 写进 `webPlugin.plugin.inject`：
 * 那样没有 sentry 的 profile 会直接起不来。web 是渠道，不是风控的一部分——它只提供入口。
 */
export function tryService<T>(ctx: Context, key: ServiceKey<T>): T | undefined {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}
