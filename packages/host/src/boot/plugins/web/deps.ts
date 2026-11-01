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

import type { HttpChannelAdapter } from '@bah/channels'
import type { Context, ServiceKey } from '@bah/core'
import type { Agent, SessionApi } from '@bah/runtime'
import type { SloSample } from '@bah/saga'
import type { HaltHandle, SentryHandle } from '@bah/safety'
import type { TenantId } from '@bah/util'

import type { HandoffHandle } from './handoff.ts'
import type { TelemetryHandle } from '../telemetry.ts'
import type { DecisionAudit } from '../audit-decisions.ts'
import type { createRateLimiter } from '../web-rate-limit.ts'
import type { SseHub } from './sse.ts'
import type { AuthRuntime, RequestIdentity } from './auth/index.ts'

/** 限流器实例类型（`createRateLimiter` 的返回，不另立接口）。 */
export type RateLimiter = ReturnType<typeof createRateLimiter>

/**
 * 交易密码安全页端口（`@bah/bank` 的 `PasswordHandoffPort` 的结构化投影）。
 *
 * 为什么在本文件重复声明形状而不是 import：`handlers/` 只允许依赖 `deps.ts` 与叶子模块，
 * 引入 `@bah/bank` 的具名类型会把"渠道层 → 银行包"的类型依赖钉进分层里（值依赖本来就有，
 * 但类型面越窄越好）。两处形状由 `channel.ts` 的赋值处编译期对齐——写错即 `tsc` 红。
 */
export interface SecurePasswordPort {
  submit(
    sessionId: string,
    req: {
      readonly ticketId: string
      readonly oldPassword: string
      readonly newPassword: string
    },
  ): Promise<{ readonly changedAt: number }>
}

/** 处理一个请求需要的全部外部状态（构造于 `apply()`，生命周期 = 插件实例）。 */
export interface WebDeps {
  /** 会话服务（读 `sessionId` / `lastSeq` / `events`）。 */
  readonly session: SessionApi
  /**
   * 本进程服务的租户（来自 `RunContext.tenantId`，01 TA-16）。
   *
   * 处理器只**读**它（`/api/metrics` 的返回体、跨租户判定），不许从请求头/查询参数取租户：
   * 客户端声明的租户永远不可信（`verify-tenant-scope` 判据 3）。
   */
  readonly tenantId: TenantId
  /**
   * 认证运行期（02 TA-24）：**唯一的**身份解析入口。
   *
   * `dispatch` 每个请求调一次 `identify()`，把结果挂到 `WebRequest.identity`；
   * 处理器只读那个结果，不自己再解析（否则就有第二份身份真相）。
   */
  readonly auth: AuthRuntime
  /** 审批 / 强验证的传输层（归属校验在适配器里；web 与 mobile 同一个实现，00 D2）。 */
  readonly adapter: HttpChannelAdapter
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
   * 惰性取审计链（03 TA-46：审批操作者入链）。
   *
   * 同样**不进** `inject`：没装 `audit:decisions` 的 profile 必须照常起。
   * 缺失时"谁批的"只存在于会话事件里，`bah audit` 会标 `machine`——不静默冒充成功。
   */
  readonly tryAudit: () => DecisionAudit | undefined
  /**
   * 惰性取遥测（可观测性 01）。
   *
   * 同样**不进** `webPlugin.plugin.inject`：没装 `obs:telemetry` 的 profile 必须照常起。
   * 调用点写 `deps.tryTelemetry()?.recorder.open(...)`——判空是义务，不是可选项。
   */
  readonly tryTelemetry: () => TelemetryHandle | undefined
  /** 惰性取 SLO 八项（没装 saga 时 `undefined`；`/api/metrics.slo` 显示 null）。 */
  readonly trySlo: () => Record<string, SloSample> | undefined
  /**
   * 惰性取交易密码安全页端口（ADR-0014）。
   *
   * 同样**不进** `inject`：没有 `bank:tools` 的 profile（headless / sdk）必须照常起，
   * 那时 `POST /api/secure/password` 回 501「本部署没有装配交易密码能力」而不是 500。
   * 类型用结构化接口（不用 `@bah/bank` 的具名类型）：渠道层不该为了一个方法把银行包拉进类型面。
   */
  readonly tryPassword: () => SecurePasswordPort | undefined
  /**
   * 人工接管状态机（C5）。状态落 `<root>/<sid>/handoff.json`；
   * 同 `--session` 重启恢复接管状态，但 boot 不重放历史会话（见 `handoff.ts`）。
   */
  readonly handoff: HandoffHandle
  /** 已解析的静态根（绝对路径）。 */
  readonly staticRoot: string
  /**
   * `/` 的落点（静态根下的绝对路径）。
   *  D3：不再写死 index.html——移动壳是第二个 HTML 壳。
   */
  readonly defaultEntry: string
  /**
   * token 入口白名单（绝对路径数组）：**只有**名单里的 HTML 注入 token 与下发 CSRF cookie。
   * 白名单比较用绝对路径精确等值（`handlers/static.ts`），不做模糊匹配。
   */
  readonly tokenEntries: readonly string[]
  /**
   * 坐席工作台入口（静态根下的绝对路径，`operator.html`）。
   * 页面**零注入**：不含 token、不带 CSRF cookie，凭证由坐席自己粘贴。
   */
  readonly operatorEntry: string
  /**
   * 坐席面是否在本渠道开放。
   *
   * 只有 `channel:web` 且配了坐席 token 才为 true：移动壳没有坐席工作台，
   * 不能让同一个 `/operator` 在移动渠道上变成"存在但打不开"的入口。
   */
  readonly seatEnabled: boolean
  /**
   * 坐席 API 是否开放（03 单：IM 网关需要子进程的 `/api/handoff/claim|message|...`）。
   *
   * 与 `seatEnabled` 分开的原因：`/operator` 页面只属于桌面 web；IM 子进程没有坐席 UI，
   * 但运营桥要转发坐席动作——把两者绑成一个布尔会让"没页面就不能有 API"。
   */
  readonly seatApiEnabled: boolean
}

/** 解析好的请求行（避免每个 handler 各自 `new URL` 一遍）。 */
export interface WebRequest {
  readonly method: string
  readonly url: URL
  readonly path: string
  /** 前缀路由的尾段（`/api/approval/t-1` → `t-1`）；其余为空串。 */
  readonly rest: string
  /**
   * 本次请求的身份（`dispatch` 解析后挂上来）。
   *
   * 为什么挂在请求上而不是让 handler 再 `identify()` 一次：同一个请求解析两次就有
   * 第二份身份真相（一次读过 cookie 后会话被撤销，两次结果会不同）。
   * 直接构造 `WebRequest` 的单测可以不给（handler 按"匿名"处理）。
   */
  readonly identity?: RequestIdentity
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
