/**
 * `channel:web` 的路由表（W16 新建）。
 *
 * 为什么必须是**数据**而不是一串 `if`：路由契约要能被快照比对。W09 加 CSRF 时最危险的
 * 变化不是"写错一个 handler"，而是"某个写路由被搬家搬漏了闸"——那种回归在纯 `if` 链里
 * 只能靠人眼，在数据表里会直接表现为一条 diff。
 *
 * 排序即优先级（`matchRoute` 取第一条命中的）：
 * 1. 探活（唯一公开 API）→ 2. 管理面（自己的 admin token，先于 Web 凭证）→
 * 3. 业务路由 → 4. 静态兜底（吃掉所有 GET/HEAD）。
 *
 * `docs/web-frontend.md` §7 的表由本文件生成（`scripts/web-routes.ts`），手写会分叉。
 */

/** 本渠道认的方法（够用即止，不引第三方路由框架 —— 宪法 R-2）。 */
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

/** 路由处理器名（与 `handlers/` 的导出一一对应，由 dispatch 查表调用）。 */
export type RouteHandler =
  | 'health'
  | 'session'
  | 'events'
  | 'metrics'
  | 'trace'
  | 'turn'
  | 'interrupt'
  | 'approval'
  | 'verify'
  | 'handoff'
  | 'admin'
  | 'static'

/**
 * 该路由的鉴权面：
 * - `public`：不需要 Web 凭证（只有探活）；
 * - `admin`：管理面，自己的 admin token + 回环绑定，**豁免 CSRF**；
 * - `web`：要求 `Authorization: Bearer`，写方法再过 CSRF；
 * - `static`：静态资源，不吃 `/api/` 前缀（`/api/*` 的未知路径仍先过凭证）。
 */
export type RouteAuth = 'public' | 'admin' | 'web' | 'static'

/** 一条路由。 */
export interface RouteSpec {
  /** 允许的方法；`methodInHandler` 时不参与匹配。 */
  readonly methods: readonly HttpMethod[]
  /** 精确路径，或 `prefix` 路由的路径前缀。 */
  readonly path: string
  readonly kind: 'exact' | 'prefix'
  readonly auth: RouteAuth
  /** 该路由是否受 CSRF 写闸（管理面豁免；只对 POST/PUT/DELETE 生效）。 */
  readonly csrf: boolean
  /**
   * 该路由**自身**可能产生的状态码（不含 500 全局兜底与 429 限流）。
   *
   * 目的只有一个：让"搬家中丢掉一个错误分支"变成可 diff 的事实。
   */
  readonly statuses: readonly number[]
  readonly handler: RouteHandler
  /** 一句话语义（进 `docs/web-frontend.md` 的生成表，不手写）。 */
  readonly note: string
  /** 文档里展示的路径（前缀路由带参数名）；缺省用 `path` 原文。 */
  readonly display?: string
  /**
   * 方法不参与匹配，交给处理器自己判。
   *
   * 只有管理面用：HP-0 §3.2 要求先判"路由是否存在"（无 token 时一律 404），
   * 再判来源（403）、再判方法（405）、最后判 token（401）。方法错要 405 而不是 404。
   */
  readonly methodInHandler?: boolean
}

/** 人工解冻的唯一入口路径（HP-0 §3.2）。 */
export const ADMIN_UNFREEZE_PATH = '/api/admin/sentry/unfreeze'
/** W07 管理面：人工 HALT / 申请解除票据 / 凭票据解除。 */
export const ADMIN_HALT_PATH = '/api/admin/halt'
export const ADMIN_HALT_REQUEST_PATH = '/api/admin/halt/unfreeze-request'
export const ADMIN_HALT_UNFREEZE_PATH = '/api/admin/halt/unfreeze'

/** 管理面的四条路由共用一份状态码集合。 */
const ADMIN_STATUSES: readonly number[] = [200, 400, 401, 403, 404, 405, 503]

/** 路由表（顺序即优先级）。 */
export const ROUTES: readonly RouteSpec[] = [
  {
    methods: ['GET'],
    path: '/api/health',
    kind: 'exact',
    auth: 'public',
    csrf: false,
    statuses: [200],
    handler: 'health',
    note: '探活：`{ ok, lastSeq, pendingTicketCount }`（只给数量，不给票据 ID）',
  },
  {
    methods: ['POST'],
    path: ADMIN_UNFREEZE_PATH,
    kind: 'exact',
    auth: 'admin',
    csrf: false,
    statuses: ADMIN_STATUSES,
    handler: 'admin',
    note: '人工解冻断路器（默认关闭，见 §7.1）',
    methodInHandler: true,
  },
  {
    methods: ['POST'],
    path: ADMIN_HALT_PATH,
    kind: 'exact',
    auth: 'admin',
    csrf: false,
    statuses: ADMIN_STATUSES,
    handler: 'admin',
    note: '人工进入 HALT（W07，见 §7.1.1）；`changed:false` 表示本来就在 HALT',
    methodInHandler: true,
  },
  {
    methods: ['POST'],
    path: ADMIN_HALT_REQUEST_PATH,
    kind: 'exact',
    auth: 'admin',
    csrf: false,
    statuses: [200, 400, 401, 403, 404, 405, 409, 503],
    handler: 'admin',
    note: '会话内发起一次 U 盾 MFA 审批，签发解除票据（无应答者 → 409）',
    methodInHandler: true,
  },
  {
    methods: ['POST'],
    path: ADMIN_HALT_UNFREEZE_PATH,
    kind: 'exact',
    auth: 'admin',
    csrf: false,
    statuses: [200, 400, 401, 403, 404, 405, 409, 503],
    handler: 'admin',
    note: '凭票据解除 HALT（唯一解除路径；没有 `force`）',
    methodInHandler: true,
  },
  {
    methods: ['GET'],
    path: '/api/session',
    kind: 'exact',
    auth: 'web',
    csrf: false,
    statuses: [200, 401],
    handler: 'session',
    note: '会话与能力位：`{ sessionId, lastSeq, capabilities }`',
  },
  {
    methods: ['GET'],
    path: '/api/events',
    kind: 'exact',
    auth: 'web',
    csrf: false,
    // 503 = SSE 连接数达到上限（D1：拒绝而不是"200 之后静默不推帧"）
    statuses: [200, 400, 401, 503],
    handler: 'events',
    note: 'SSE：先全量快照，再推 frame / delta / 心跳注释；凭证可用 `?token=`；连接满 → 503',
  },
  {
    methods: ['GET'],
    path: '/api/metrics',
    kind: 'exact',
    auth: 'web',
    csrf: false,
    // D2：单机指标（从会话事件现算；不出原文，不是分布式监控）
    // 400 = `?format` 非法（02 起支持 json / prometheus）
    statuses: [200, 400, 401],
    handler: 'metrics',
    note: '单机指标：turn / 工具成功失败 / 审批分布 / token 与成本 / 工具耗时分位 / SSE 连接数',
  },
  {
    methods: ['GET'],
    path: '/api/trace',
    kind: 'exact',
    auth: 'web',
    csrf: false,
    // 400 = format/limit 非法；503 = 序列化超过 4 MiB（不截断返回半棵树）
    statuses: [200, 400, 401, 503],
    handler: 'trace',
    note: '轨迹：事件派生的 span 森林；`?format=chrome` 导出 Chrome Trace（Perfetto 可直接打开）',
  },
  {
    methods: ['POST'],
    path: '/api/turn',
    kind: 'exact',
    auth: 'web',
    csrf: true,
    statuses: [202, 400, 401, 403, 423, 503],
    handler: 'turn',
    note: '提交一轮输入 `{ text }` → 入队并驱动；202 = 已入队，HALT 期间 423',
  },
  {
    methods: ['POST'],
    path: '/api/interrupt',
    kind: 'exact',
    auth: 'web',
    csrf: true,
    statuses: [200, 401, 403, 503],
    handler: 'interrupt',
    note: '打断当前 turn `{ reason? }`（理由进审计）',
  },
  {
    methods: ['POST'],
    path: '/api/approval/',
    kind: 'prefix',
    auth: 'web',
    csrf: true,
    statuses: [200, 400, 401, 403, 404, 409],
    handler: 'approval',
    note: '提交审批结论 `{ decision, reason? }`；跨会话票据 403',
    display: '/api/approval/:ticketId',
  },
  {
    methods: ['POST'],
    path: '/api/verify/',
    kind: 'prefix',
    auth: 'web',
    csrf: true,
    statuses: [200, 400, 401, 403, 404],
    handler: 'verify',
    note: '红级票据的强验证（挑战由 VerifyService 签发）',
    display: '/api/verify/:ticketId',
  },
  {
    methods: ['GET'],
    path: '/api/handoff',
    kind: 'exact',
    auth: 'web',
    csrf: false,
    // C5：人工侧读取接管摘要（只读；持 Web 凭证即可，单用户部署）
    statuses: [200, 401],
    handler: 'handoff',
    note: '人工接管摘要：`{ active, sessionId, lastSeq, turns, pendingTickets, messages[], reason?, at? }`',
  },
  {
    methods: ['POST'],
    path: '/api/handoff',
    kind: 'exact',
    auth: 'web',
    csrf: true,
    // 409 = 已经在接管中（重复请求不刷新 `at`，否则"等了多久"失真）
    statuses: [200, 400, 401, 403, 409],
    handler: 'handoff',
    note: '请求人工接管 `{ reason? }`：之后 `/api/turn` 一律 409，模型不再自动驱动',
  },
  {
    methods: ['POST'],
    path: '/api/handoff/resume',
    kind: 'exact',
    auth: 'web',
    csrf: true,
    statuses: [200, 400, 401, 403, 409],
    handler: 'handoff',
    note: '交回会话 `{ operator? }`；未接管时 409——不做"幂等成功"，交回必须是真的一次状态转移',
  },
  {
    // 静态兜底：吃掉所有 GET/HEAD（含未知 `/api/*`，它们会被解析成 404 而不是 405）
    methods: ['GET', 'HEAD'],
    path: '/',
    kind: 'prefix',
    auth: 'static',
    csrf: false,
    // 400 = 路径不是合法百分号编码（D6：畸形 `%` 序列以前冒成 500）
    statuses: [200, 400, 404],
    handler: 'static',
    note: '静态资源（默认根目录见 §7.2；纯原生 ES 模块，无需构建）；畸形百分号编码 → 400',
    display: '/*',
  },
]

/** 命中的路由。 */
export interface RouteMatch {
  readonly spec: RouteSpec
  /** 前缀路由的尾段（`/api/approval/t-1` → `t-1`；其余为空串）。 */
  readonly rest: string
}

/** 方法不支持时的状态码（表外兜底，不是一条路由）。 */
export const METHOD_NOT_ALLOWED_STATUS = 405

/** 方法不支持时的错误码。 */
export const METHOD_NOT_ALLOWED_CODE = 'web-method-not-allowed'

/**
 * 按顺序找第一条命中的路由。
 *
 * `methodInHandler` 的路由只按路径匹配——它们必须能走到"方法错 → 405"，
 * 而 405 又必须排在"路由是否存在（404）"之后。
 */
export function matchRoute(method: string, path: string): RouteMatch | undefined {
  for (const spec of ROUTES) {
    const hit = spec.kind === 'exact' ? path === spec.path : path.startsWith(spec.path)
    if (!hit) continue
    const methodOk = spec.methods.some((allowed) => allowed === method)
    if (!methodOk && spec.methodInHandler !== true) continue
    return { spec, rest: spec.kind === 'prefix' ? path.slice(spec.path.length) : '' }
  }
  return undefined
}
