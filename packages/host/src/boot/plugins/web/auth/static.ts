/**
 * `static` 模式的双凭证识别（合流 2026-10-29 · T-06）。
 *
 * ## 为什么需要它
 *
 * 合流前 `static` 模式只有一个 Web token，所有请求都变成同一个合成主体 `svc:web`，
 * 该主体同时带 `customer` / `agent` / `auditor` 三个角色——等于"客户页凭证也能打坐席 API"。
 * 合流把客户与坐席的凭证拆成两把，主体也随之分成两个：
 *
 * | 凭证 | 主体 | 角色 |
 * |---|---|---|
 * | `BAH_WEB_TOKEN` | `svc:web` | `customer` |
 * | `BAH_OPERATOR_TOKEN` | `svc:operator` | `agent` |
 *
 * ## 三条纪律
 *
 * 1. **先比 operator 再比 web**：两把 token 在 boot 期已被 `readOperatorConfig` 拒绝相同，
 *    这里的顺序只影响计时，不影响结论；但固定顺序让侧信道可分析。
 * 2. **定长比较，且长度不等也走一次比较**（`secretEqual`）——不把长度当快速失败。
 * 3. **不接受 `?token=` 之外的查询参数**：查询参数由 `identity.ts` 只对 `/api/events`
 *    读取；本模块只收已经提取好的"出示凭证"。
 */

import { normalizePrincipal, type Principal, type Role, type TenantId } from '@bah/util'

import { secretEqual } from '../../web-operator.ts'

/** `svc:web` 的角色：只做客户动作（不含 agent / auditor / admin）。 */
export const STATIC_WEB_ROLES: readonly Role[] = ['customer']

/** `svc:operator` 的角色：只做坐席动作（不含 customer）。 */
export const STATIC_OPERATOR_ROLES: readonly Role[] = ['agent']

/** 合成主体 id（写进审计链，不要改：改了历史主体对不上）。 */
export const STATIC_WEB_USER = 'svc:web'
export const STATIC_OPERATOR_USER = 'svc:operator'

/** 识别器入参。 */
export interface StaticIdentifierOptions {
  readonly tenantId: TenantId
  readonly webToken: string
  readonly operatorToken: string | undefined
}

/** 出示凭证 → 主体（不匹配 / 未出示 → `undefined`）。 */
export type StaticIdentifier = (presented: string | undefined) => Principal | undefined

/**
 * 造一个 static 模式识别器。
 *
 * @param options 见 {@link StaticIdentifierOptions}
 */
export function createStaticIdentifier(options: StaticIdentifierOptions): StaticIdentifier {
  const web = normalizePrincipal({
    tenantId: options.tenantId,
    userId: STATIC_WEB_USER,
    roles: STATIC_WEB_ROLES,
    source: 'demo-config',
  })
  const operator = normalizePrincipal({
    tenantId: options.tenantId,
    userId: STATIC_OPERATOR_USER,
    roles: STATIC_OPERATOR_ROLES,
    source: 'demo-config',
  })

  return (presented) => {
    const token = bearerOf(presented)
    if (token === undefined) return undefined
    if (options.operatorToken !== undefined && secretEqual(options.operatorToken, token)) {
      return operator
    }
    if (secretEqual(options.webToken, token)) return web
    return undefined
  }
}

/**
 * 从 `Authorization` / SSE 的 `?token=` 里取出 Bearer 后的裸 token。
 *
 * `presentedWebToken` 的返回值已经是 `Bearer xxx` 形状；这里剥前缀用正则而不是
 * `slice`，因为大小写与空白都允许（`Bearer\\s+`）。
 */
function bearerOf(presented: string | undefined): string | undefined {
  if (presented === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(presented.trim())
  const token = match?.[1]?.trim()
  return token === undefined || token === '' ? undefined : token
}
