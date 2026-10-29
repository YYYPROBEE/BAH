/**
 * `channel:web` 的路由表（W16 新建）。
 *
 * 为什么必须是**数据**而不是一串 `if`：路由契约要能被快照比对。W09 加 CSRF 时最危险的
 * 变化不是"写错一个 handler"，而是"某个写路由被搬家搬漏了闸"——那种回归在纯 `if` 链里
 * 只能靠人眼，在数据表里会直接表现为一条 diff。
 *
 * 排序即优先级（`matchRoute` 取第一条命中的）：
 * 1. 探活 / 登录（公开）→ 2. 管理面（自己的 admin token，先于 Web 凭证）→
 * 3. 业务路由 → 4. 坐席入口 → 5. 静态兜底（吃掉所有 GET/HEAD）。
 *
 * `roles` 是 03 的增量（TA-40）：**只加字段，不改 `auth`**。角色判定只在
 * `authz/authorize.ts` 一处（Z1），本表只声明"谁能进"。
 *
 * 合流（2026-10-29）后只剩四种鉴权面：`public` / `admin` / `web` / `static`。
 * handoff 线临时的 `auth:'user'|'operator'` 已删除——客户/坐席的分离改由 `roles` 表达；
 * 坐席面是否开放由 `seatEnabled`（配置与环境变量）控制，不写进路由表。
 *
 * `docs/web-frontend.md` §7 的表由本文件生成（`scripts/web-routes.ts`），手写会分叉。
 */

import { BahError, ROLES, type Role } from '@bah/util'

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
  | 'handoff-message'
  | 'handoff-claim'
  | 'handoff-heartbeat'
  | 'handoff-queue'
  | 'fork'
  | 'admin'
  | 'login'
  | 'logout'
  | 'me'
  | 'static'

/**
 * 该路由的鉴权面：
 * - `public`：不需要 Web 凭证（探活 / 登录 / 幂等登出）；
 * - `admin`：管理面，自己的 admin token + 回环绑定，**豁免 CSRF**；
 * - `web`：要求已认证主体（static 凭证或 password 会话），写方法再过 CSRF；
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
  /**
   * 允许的角色（03 TA-40）。缺省 = 任何已认证主体都行（**不是**"全放行"）。
   *
   * `auth !== 'web'` 的路由一律不写：公开路由没有主体，管理面走自己的 token（双因子），
   * 静态资源没有主体概念。`assertRouteRoles` 在模块加载期校验取值与顺序。
   */
  readonly roles?: readonly Role[]
  /**
   * 资源归属要求（03 TA-40）。`'self'` = 目标票据必须属于该主体。
   *
   * **声明式，当前没有执行者**：`authorize()` 不读它，审计与门禁也还没消费。
   * 真正的归属判定在渠道适配器（它握着 `pending` 表），状态码沿用 403 `foreign-ticket`；
   * 保留这个字段的价值是把"这条路由要求归属"钉进契约，供评审与后续消费者使用。
   * 复审 AR-02：把它改成 404 只会毁掉 `web.test.ts` 的 403 基线，而 `foreign-ticket`
   * 在当前形态下不可达。
   */
  readonly scope?: 'self' | 'any'
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
  /**
   * 坐席面路由（合流 2026-10-29）：坐席未启用（未配 `BAH_OPERATOR_TOKEN`、非 web 渠道，
   * 或 password 模式本轮不开放坐席）时整条 404——**在身份解析之前**判，401 会暴露存在性。
   */
  readonly seat?: boolean
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
    // 登录是**公开**路由（还没身份），但**必须过 CSRF**：否则存在"登录 CSRF"
    // （攻击者让受害者登录攻击者的账户，之后受害者的操作全部落在攻击者账上）
    path: '/api/auth/login',
    kind: 'exact',
    auth: 'public',
    csrf: true,
    statuses: [200, 400, 401, 403, 409, 503],
    handler: 'login',
    note: '登录 `{ userId, password }` → 下发 HttpOnly 会话 cookie 并轮换 CSRF；失败与"用户不存在"同形',
  },
  {
    methods: ['POST'],
    path: '/api/auth/logout',
    kind: 'exact',
    // **public** 而不是 web：登出必须幂等（02 TA-26 的"再次 logout → 200"）。
    // 如果要求主体，第二次登出（cookie 已失效）会变成 401——那就不叫幂等了。
    auth: 'public',
    csrf: true,
    statuses: [200, 403],
    handler: 'logout',
    note: '登出（幂等：没有会话也 200，但会清 cookie；public + CSRF）',
  },
  {
    methods: ['GET'],
    path: '/api/auth/me',
    kind: 'exact',
    auth: 'web',
    csrf: false,
    statuses: [200, 401],
    handler: 'me',
    roles: ROLES,
    note: '自查：`{ tenant, userId, roles, expiresAt, mode }`（**不回 sid**）',
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
    roles: ROLES,
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
    roles: ROLES,
    note: 'SSE：先全量快照，再推 frame / delta / 心跳注释；static 模式凭证可用 `?token=`（password 模式只认 cookie）；连接满 → 503',
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
    roles: ROLES,
    note: '单机指标：turn / 工具成功失败 / 审批分布 / token 与成本 / 工具耗时分位 / SSE 连接数；第一层带 `tenant`',
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
    roles: ROLES,
    note: '轨迹：事件派生的 span 森林；`?format=chrome` 导出 Chrome Trace（Perfetto 可直接打开）；D4：当前按调试面处理（ROLES），生产应收窄到 auditor/admin',
  },
  {
    methods: ['POST'],
    path: '/api/session/fork',
    kind: 'exact',
    auth: 'web',
    csrf: true,
    // 400 = turn 非法；404 = 无活动会话；409 = 边界 turn 未结束 / 接管期；500 = 原日志断代
    statuses: [200, 400, 401, 403, 404, 405, 409, 500],
    handler: 'fork',
    roles: ['customer', 'admin'],
    note: '在 turn 边界分叉新会话 `{ turn }`（旧会话原样封存；新会话仅进程内存在）',
  },
  {
    methods: ['POST'],
    path: '/api/turn',
    kind: 'exact',
    auth: 'web',
    csrf: true,
    statuses: [202, 400, 401, 403, 423, 503],
    handler: 'turn',
    // 客户专属（D3）：坐席不代客户发消息；接管期间 202 落账不驱动
    roles: ['customer'],
    note: '提交一轮输入 `{ text }` → 入队并驱动；202 = 已入队，HALT 期间 423；接管期间 202 落账不驱动',
  },
  {
    methods: ['POST'],
    path: '/api/interrupt',
    kind: 'exact',
    auth: 'web',
    csrf: true,
    statuses: [200, 401, 403, 503],
    handler: 'interrupt',
    // 客户专属（D3）：坐席不能替客户打断
    roles: ['customer'],
    note: '打断当前 turn `{ reason? }`（理由进审计）；客户专属，坐席 403',
  },
  {
    methods: ['POST'],
    path: '/api/approval/',
    kind: 'prefix',
    auth: 'web',
    csrf: true,
    statuses: [200, 400, 401, 403, 404, 409],
    handler: 'approval',
    // 资金动作只许客户（D3）：坐席不能替客户放行
    roles: ['customer'],
    // 票据是最容易跨会话重放的对象：归属由适配器按主体再判一次（仍是 403 foreign-ticket）
    scope: 'self',
    note: '提交审批结论 `{ decision, reason? }`；跨会话票据 403；客户专属',
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
    // 强验证是客户本人的动作（D3）
    roles: ['customer'],
    scope: 'self',
    note: '红级票据的强验证（挑战由 VerifyService 签发）；客户专属',
    display: '/api/verify/:ticketId',
  },
  {
    methods: ['GET'],
    path: '/api/handoff',
    kind: 'exact',
    auth: 'web',
    csrf: false,
    statuses: [200, 401],
    handler: 'handoff',
    roles: ROLES,
    note: '人工接管摘要：`{ active, sessionId, lastSeq, turns, pendingTickets, messages[], reason?, at?, waitedMs, overdue, claimed, operatorMessages, operator?, requestedBy?, operatorId? }`',
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
    roles: ['customer', 'agent', 'admin'],
    note: '请求人工接管 `{ reason? }`：进入者从登录主体派生（`requestedBy`）；接管期间 `/api/turn` 202 落账但不驱动模型',
  },
  {
    methods: ['POST'],
    path: '/api/handoff/resume',
    kind: 'exact',
    auth: 'web',
    seat: true,
    csrf: true,
    statuses: [200, 400, 401, 403, 409],
    handler: 'handoff',
    // 交回是坐席的动作；客户的"算了"走 `/api/interrupt`（03 §2.2 设计理由 3）
    roles: ['agent', 'admin'],
    note: '交回会话 `{ handover? }`（操作者从登录主体派生，body 不接受 operator）；未接管时 409',
  },
  {
    methods: ['POST'],
    path: '/api/handoff/message',
    kind: 'exact',
    auth: 'web',
    seat: true,
    csrf: true,
    statuses: [200, 400, 401, 403, 404, 409, 413],
    handler: 'handoff-message',
    roles: ['agent', 'admin'],
    note: '坐席发言 `{ text }`：落 `handoff/operator-message`（不进模型历史）；发言主体从登录主体派生',
  },
  {
    methods: ['POST'],
    path: '/api/handoff/claim',
    kind: 'exact',
    auth: 'web',
    seat: true,
    csrf: true,
    statuses: [200, 401, 403, 404, 409],
    handler: 'handoff-claim',
    roles: ['agent', 'admin'],
    note: '坐席认领（幂等；换人 409）——认领只改显示与审计，不改变 `/api/turn` 的接管语义',
  },
  {
    methods: ['POST'],
    path: '/api/handoff/heartbeat',
    kind: 'exact',
    auth: 'web',
    seat: true,
    csrf: true,
    statuses: [200, 401, 403, 404],
    handler: 'handoff-heartbeat',
    roles: ['agent', 'admin'],
    note: '等待时长与超时判定（只告警，不自动交回）；未接管时返回 waitedMs:0',
  },
  {
    methods: ['GET'],
    path: '/api/handoff/queue',
    kind: 'exact',
    auth: 'web',
    seat: true,
    csrf: false,
    statuses: [200, 401, 403, 404],
    handler: 'handoff-queue',
    roles: ['agent', 'auditor', 'admin'],
    note: '单会话部署：depth ∈ {0,1}（审计员只读；坐席动作仍需 agent/admin）',
  },
  {
    // 坐席工作台入口。static：页面本身必须能打开才能输凭证；**页面里没有任何凭证**。
    // 未配置 BAH_OPERATOR_TOKEN（或非 web 渠道）时由 handleStatic 返回 404（不暴露存在性）。
    methods: ['GET'],
    path: '/operator',
    kind: 'exact',
    auth: 'static',
    csrf: false,
    statuses: [200, 404],
    handler: 'static',
    note: '坐席工作台入口（零注入；static 模式凭证由坐席粘贴，存 sessionStorage）',
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

/**
 * 校验 `roles` 声明（03 TA-40；模块加载期跑一遍）。
 *
 * 三条判据：**非空**、**取值合法**、**按 `ROLES` 固定序**。
 * 固定序不是洁癖：主体序列化要对它算哈希，`['agent','customer']` 与
 * `['customer','agent']` 语义相同却字节不同，审计链会把它当两个主体。
 */
export function assertRouteRoles(path: string, roles: readonly Role[] | undefined): void {
  if (roles === undefined) return
  if (roles.length === 0) {
    throw new BahError(
      'web-invalid-route',
      `${path}: roles 不允许空数组（不声明 = 任何已认证主体；要拒绝全部请删掉路由）`,
    )
  }
  const seen = new Set<Role>()
  let lastIndex = -1
  for (const role of roles) {
    const index = ROLES.indexOf(role)
    if (index < 0) {
      throw new BahError('web-invalid-route', `${path}: 未知角色 ${JSON.stringify(role)}`)
    }
    if (seen.has(role)) {
      throw new BahError('web-invalid-route', `${path}: 角色重复 ${role}`)
    }
    if (index <= lastIndex) {
      throw new BahError(
        'web-invalid-route',
        `${path}: roles 必须按 ROLES 序（customer, agent, auditor, admin），收到 ${roles.join(',')}`,
      )
    }
    lastIndex = index
    seen.add(role)
  }
}

// 模块加载期自检：路由表写错是**开发期错误**，不许活到第一次请求。
for (const route of ROUTES) {
  if (route.auth !== 'web' && route.roles !== undefined) {
    throw new BahError('web-invalid-route', `${route.path}: auth=${route.auth} 的路由不许声明 roles`)
  }
  assertRouteRoles(route.path, route.roles)
}

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
