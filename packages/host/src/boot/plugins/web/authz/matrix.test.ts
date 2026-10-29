/**
 * 越权矩阵（03 TA-48）：4 角色 × 11 条 Web 路由，一张表一个循环。
 *
 * 为什么不用真实 HTTP 跑 44 次：慢、要端口、要 cookie 管理，而且失败时看不出是
 * "授权错了"还是"服务没起来"。这里直接调 `authorize()` 纯函数，1 秒内跑完。
 *
 * 比循环本身更值钱的是**双向覆盖**：路由表加了一条而矩阵没加，立刻红——
 * "新路由忘了想清楚谁能进"正是越权的头号来源。
 */

import { describe, expect, it } from 'vitest'

import { normalizePrincipal, parseTenantId, ROLES, type Role } from '@bah/util'

import type { RequestIdentity } from '../auth/identity.ts'
import type { AuthSession } from '../auth/session-store.ts'
import { authorize } from './authorize.ts'
import { matchRoute, ROUTES, type RouteSpec } from '../router.ts'

/** 矩阵的一行：`routePath` 是 `ROUTES` 里的声明路径，`path` 是实际请求样例。 */
interface MatrixRow {
  readonly method: string
  readonly routePath: string
  readonly path: string
  readonly allow: readonly Role[]
}

/** §2.2 的路由矩阵（`logout` 是 public，不在本表；见 03 偏差 D-2）。 */
export const MATRIX: readonly MatrixRow[] = [
  { method: 'GET', routePath: '/api/auth/me', path: '/api/auth/me', allow: ROLES },
  { method: 'GET', routePath: '/api/session', path: '/api/session', allow: ROLES },
  { method: 'GET', routePath: '/api/events', path: '/api/events', allow: ROLES },
  { method: 'GET', routePath: '/api/metrics', path: '/api/metrics', allow: ROLES },
  { method: 'POST', routePath: '/api/turn', path: '/api/turn', allow: ['customer', 'admin'] },
  {
    method: 'POST',
    routePath: '/api/interrupt',
    path: '/api/interrupt',
    allow: ['customer', 'agent', 'admin'],
  },
  {
    method: 'POST',
    routePath: '/api/approval/',
    path: '/api/approval/t-1',
    allow: ['customer', 'agent', 'admin'],
  },
  {
    method: 'POST',
    routePath: '/api/verify/',
    path: '/api/verify/t-1',
    allow: ['customer', 'agent', 'admin'],
  },
  { method: 'GET', routePath: '/api/handoff', path: '/api/handoff', allow: ROLES },
  {
    method: 'POST',
    routePath: '/api/handoff',
    path: '/api/handoff',
    allow: ['customer', 'agent', 'admin'],
  },
  {
    method: 'POST',
    routePath: '/api/handoff/resume',
    path: '/api/handoff/resume',
    allow: ['agent', 'admin'],
  },
]

/** 造一个单角色主体。 */
function identityOf(role: Role): RequestIdentity {
  const tenantId = parseTenantId('demo')
  const principal = normalizePrincipal({
    tenantId,
    userId: 'u-1',
    roles: [role],
    source: 'session-auth',
  })
  const session: AuthSession = {
    sid: 'sid-1',
    tenantId: 'demo',
    userId: 'u-1',
    roles: [role],
    csrf: 'csrf-1',
    issuedAt: 0,
    lastSeenAt: 0,
    absoluteExpiresAt: 1_000,
  }
  return { kind: 'principal', principal, session }
}

/** 双向覆盖缺口（纯函数：测试可以传入"被篡改的路由表"）。 */
export function coverageGaps(routes: readonly RouteSpec[]): string[] {
  const matrixKeys = new Set(MATRIX.map((row) => `${row.method} ${row.routePath}`))
  const routeKeys = new Set(
    routes
      .filter((route) => route.auth === 'web')
      .map((route) => `${route.methods.join('|')} ${route.path}`),
  )
  const gaps: string[] = []
  for (const key of routeKeys) {
    if (!matrixKeys.has(key)) gaps.push(`路由 ${key} 未进越权矩阵`)
  }
  for (const key of matrixKeys) {
    if (!routeKeys.has(key)) gaps.push(`矩阵 ${key} 不在 ROUTES`)
  }
  return gaps
}

describe('TA-48 · 角色 × 路由矩阵', () => {
  it('44 格逐格判定：允许的角色 ok，其余 403 web-forbidden', () => {
    for (const row of MATRIX) {
      const match = matchRoute(row.method, row.path)
      expect(match?.spec.path, `${row.method} ${row.path} 没命中 ${row.routePath}`).toBe(
        row.routePath,
      )
      for (const role of ROLES) {
        const verdict = authorize({
          identity: identityOf(role),
          spec: match!.spec,
          method: row.method,
          path: row.path,
          isApi: true,
        })
        const expected = row.allow.includes(role)
        if (expected) {
          expect(verdict.ok, `${role} 应能访问 ${row.method} ${row.routePath}`).toBe(true)
        } else {
          expect(verdict, `${role} 不应能访问 ${row.method} ${row.routePath}`).toMatchObject({
            ok: false,
            status: 403,
            code: 'web-forbidden',
          })
        }
      }
    }
  })

  it('匿名一律 401（角色表不改变"先身份后角色"）', () => {
    for (const row of MATRIX) {
      const match = matchRoute(row.method, row.path)
      expect(
        authorize({
          identity: { kind: 'anonymous' },
          spec: match!.spec,
          method: row.method,
          path: row.path,
          isApi: true,
        }),
        `匿名不应能访问 ${row.method} ${row.routePath}`,
      ).toMatchObject({ ok: false, status: 401, code: 'web-unauthorized' })
    }
  })

  it('矩阵与 `ROUTES` 双向覆盖（新路由不进矩阵 → 红）', () => {
    expect(coverageGaps(ROUTES)).toEqual([])
  })

  it('临时往路由表插一条 web 路由 → 双向覆盖立刻发现', () => {
    const template = ROUTES.find((route) => route.auth === 'web')
    expect(template).toBeDefined()
    const injected: RouteSpec = {
      ...template!,
      methods: ['POST'],
      path: '/api/privileged',
      handler: 'session',
    }
    expect(coverageGaps([...ROUTES, injected])).toContain(
      '路由 POST /api/privileged 未进越权矩阵',
    )
  })
})
