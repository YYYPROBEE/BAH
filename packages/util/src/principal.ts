/**
 * 主体（Principal）与角色（租户与鉴权 01 · TA-10）。
 *
 * ## 三条不变量（写进测试，不写成注释）
 *
 * 1. `roles.length >= 1`——空集不是"无权限"，是**构造错误**：权限判定拿一个空集
 *    去比对，任何"缺省放行"的实现都会把它读成更宽的角色。必须在解析处 loud。
 * 2. 去重 + 按 {@link ROLES} 固定序——审计链要对主体算哈希，两次逻辑相同的构造
 *    必须序列化出同一串字节（否则"是谁批的"对不上）。
 * 3. `tenantId` 是 `TenantId` 品牌类型，且运行期再校验一次——`asTenantId` 是
 *    无校验断言，这里是它唯一的下游兜底。
 *
 * ## 为什么不在这里做权限判定
 *
 * 本文件只回答"**你是谁**"。"**你能干什么**"是 T3 的 `authorize()`，
 * 两者分开才能解释"同一笔转账换个角色级别为什么变红"。
 */

import { BahError } from './util/errors.ts'
import { isTenantId, type TenantId } from './tenant.ts'

/** 渠道角色（**不是**业务权限：业务权限仍是绿/黄/红三级，两个平面正交）。 */
export type Role = 'customer' | 'agent' | 'auditor' | 'admin'

/**
 * 角色枚举的**固定序**（序列化顺序 = 这个序）。
 *
 * 顺序调整会改变主体哈希 ⇒ 审计链上历史条目的 `subject` 会与重算值不一致。
 * 只许在末尾追加，且要同时升 `tenant-model` 契约版本。
 */
export const ROLES: readonly Role[] = ['customer', 'agent', 'auditor', 'admin']

/**
 * 身份的来源（可追溯"这个主体是怎么来的"）。
 *
 * T2 的登录会用 `'session-auth'`；另外三个是 09 已有的渠道。
 */
export type IdentitySource = 'demo-config' | 'mock-login' | 'im-map' | 'session-auth'

/** 身份来源全集（运行期校验用；顺序即声明顺序）。 */
export const IDENTITY_SOURCES: readonly IdentitySource[] = [
  'demo-config',
  'mock-login',
  'im-map',
  'session-auth',
]

/** 一个已认证的主体。 */
export interface Principal {
  readonly tenantId: TenantId
  /** 银行口径的客户号（必须存在于数据集）。 */
  readonly userId: string
  /** 非空、去重、按 {@link ROLES} 序。 */
  readonly roles: readonly Role[]
  readonly source: IdentitySource
}

/** `normalizePrincipal` 的输入（形状同上，但允许任意 `string` 角色/来源，交给运行期校验）。 */
export interface PrincipalInput {
  readonly tenantId: TenantId
  readonly userId: string
  readonly roles: readonly string[]
  readonly source: string
}

/**
 * 规范化主体：校验 + 去重 + 排序 + 冻结。
 *
 * **返回新对象，绝不原地改**——调用方后面 `roles.push()` 一下，审计链里的主体哈希
 * 就会变，而"是谁批的"再也对不上（TA-10 的反例）。
 *
 * @throws `BahError('principal-roles-empty')` 角色为空
 * @throws `BahError('principal-role-invalid')` 角色不在 {@link ROLES} 里
 * @throws `BahError('principal-source-invalid')` 来源不在 {@link IDENTITY_SOURCES} 里
 * @throws `BahError('principal-tenant-invalid')` 租户 ID 不合法（`asTenantId` 的兜底）
 * @throws `BahError('principal-user-invalid')` 用户 ID 为空 / 含分隔符
 */
export function normalizePrincipal(input: PrincipalInput): Principal {
  const tenantId = String(input.tenantId)
  if (!isTenantId(tenantId)) {
    throw new BahError(
      'principal-tenant-invalid',
      `主体租户非法：${JSON.stringify(tenantId)}（TenantId 必须经 parseTenantId 产出）`,
      { tenantId },
    )
  }

  const userId = input.userId.trim()
  if (userId.length === 0 || /[/\\\0]/.test(userId)) {
    throw new BahError(
      'principal-user-invalid',
      `主体用户 ID 非法：${JSON.stringify(input.userId)}（必须非空且不含路径分隔符）`,
      { userId: input.userId },
    )
  }

  if (input.roles.length === 0) {
    throw new BahError('principal-roles-empty', '主体至少要有一个角色（空集是构造错误，不是无权限）', {
      userId,
    })
  }
  const unknown = input.roles.filter((role) => !(ROLES as readonly string[]).includes(role))
  if (unknown.length > 0) {
    throw new BahError(
      'principal-role-invalid',
      `主体角色非法：${unknown.join(', ')}（可写：${ROLES.join(' / ')}）`,
      { roles: unknown },
    )
  }

  const source = String(input.source)
  if (!(IDENTITY_SOURCES as readonly string[]).includes(source)) {
    throw new BahError(
      'principal-source-invalid',
      `主体来源非法：${source}（可写：${IDENTITY_SOURCES.join(' / ')}）`,
      { source },
    )
  }

  // 去重 + 按固定序：`new Set` 保留首见顺序，随后按 ROLES 索引重排
  const unique = [...new Set(input.roles as readonly Role[])]
  const roles = Object.freeze(
    [...ROLES].filter((role) => unique.includes(role)),
  )

  return Object.freeze({
    tenantId: tenantId as TenantId,
    userId,
    roles,
    source: source as IdentitySource,
  })
}

/** 主体是否具备某角色（**只回答渠道角色**，不做业务权限判定）。 */
export function hasRole(principal: Principal, role: Role): boolean {
  return principal.roles.includes(role)
}
