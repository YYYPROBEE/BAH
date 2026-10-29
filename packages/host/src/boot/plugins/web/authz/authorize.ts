/**
 * 授权判定（租户与鉴权 03 · TA-41）：**唯一**的角色判定点。
 *
 * 为什么必须是纯函数：判定树要能被矩阵用例一秒跑完 44 格（4 角色 × 11 条 Web 路由），
 * 不需要端口、cookie 与服务装配；失败时能一眼看出"授权错了"而不是"服务没起来"。
 *
 * ## 顺序即语义
 *
 * ```text
 * 1 public  → 放行（不解析身份：登录/登出/探活本来就没有主体）
 * 2 admin   → 放行（管理面在 guardAdmin 里已判 token + 回环；这里再验一次就是第二真相源）
 * 3 static  → 非 /api/ 前缀放行；/api/ 前缀（未知路径落到静态兜底）仍要身份
 * 4 匿名    → 401（**先身份后角色**：403 不能成为"你没登录"的回答）
 * 5 角色不交 → 403
 * 6 其余    → 放行
 * ```
 *
 * `scope: 'self'` **不在这里判**（复审 AR-02）：`authorize()` 拿不到 `pending` 表，
 * 归属判定仍在 `@bah/channels` 的适配器里，状态码也沿用今天的 403 `foreign-ticket`。
 * 本函数的 `scope` 只作为声明供审计/门禁读取。
 *
 * 反例（为什么不能在这里再解析 cookie）：`identify()` 与 `authorize()` 会各算一次身份；
 * 中间任何变化（`touch()` 更新 `lastSeenAt`、会话恰好被撤销）都会让两处结论不同。
 * 身份**只解析一次**，由 `dispatch` 传进来。
 */

import type { Role } from '@bah/util'

import type { RequestIdentity } from '../auth/identity.ts'
import type { RouteSpec } from '../router.ts'

/** 判定只需要路由的两项：鉴权面与允许角色（不依赖 `methods` / `statuses` 等展示字段）。 */
export type AuthorizeSpec = Pick<RouteSpec, 'auth' | 'roles'>

/** 判定输入。 */
export interface AuthorizeInput {
  /** `dispatch` 解析好的身份（**不再解析一次**）。 */
  readonly identity: RequestIdentity
  /** 命中的路由；未命中时用合成的 `{ auth: 'web' }` / `{ auth: 'static' }`。 */
  readonly spec: AuthorizeSpec
  /** 请求方法与路径（只进诊断与测试断言，不参与判定）。 */
  readonly method: string
  readonly path: string
  /**
   * 是否 `/api/` 前缀。
   *
   * **独立维度**，不依赖路由命中：`GET /api/unknown` 会命中静态兜底，
   * 但"未知 API 也要先过身份"不能因此失效。
   */
  readonly isApi: boolean
}

/** 判定结论。`404` 保留在联合里只为契约完整——当前形态不会返回（见 AR-02）。 */
export type AuthorizeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly status: 401 | 403 | 404
      readonly code: string
      readonly reason: string
    }

/** 允许的角色里是否有交集。 */
function intersects(granted: readonly Role[], required: readonly Role[]): boolean {
  return required.some((role) => granted.includes(role))
}

/**
 * 判定一次请求（纯函数，不抛）。
 *
 * @param input 见 {@link AuthorizeInput}
 */
export function authorize(input: AuthorizeInput): AuthorizeVerdict {
  const { identity, spec, isApi } = input

  // 1. 公开路由：没有主体概念（登录还没身份；登出必须幂等；探活只给数量）
  if (spec.auth === 'public') return { ok: true }

  // 2. 管理面：双因子在 guardAdmin（token + 回环），不在这里重验
  if (spec.auth === 'admin') return { ok: true }

  // 3. 静态资源：浏览器直接打开页面不需要主体。
  //    但 `/api/*` 的未知路径会命中静态兜底——那仍然是一次 API 探测，必须过身份。
  if (spec.auth === 'static' && !isApi) return { ok: true }

  // 4. 先身份后角色：匿名一律 401（403 只说"你没权限"，不能代替"你没登录"）
  if (identity.kind === 'anonymous') {
    return { ok: false, status: 401, code: 'web-unauthorized', reason: '缺少或错误的访问凭证' }
  }

  // 3'. 未知 API 路径（静态兜底 + isApi）：身份已通过，交给 404/405
  if (spec.auth === 'static') return { ok: true }

  // 5. 角色门。缺省 roles = 任何已认证主体都行（**不是**"未声明 = 全放行"：
  //    第 4 步已经挡掉匿名；这里放行的只有已认证主体）
  if (spec.roles !== undefined && !intersects(identity.principal.roles, spec.roles)) {
    return {
      ok: false,
      status: 403,
      code: 'web-forbidden',
      // 不回显主体角色：错误信息不该成为角色探测面
      reason: `需要角色：${spec.roles.join(' / ')}`,
    }
  }

  return { ok: true }
}
