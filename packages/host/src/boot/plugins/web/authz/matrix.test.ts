/**
 * 越权矩阵（03 TA-48；合流 2026-10-29 扩到 18 行）：4 角色 × 18 条 Web 路由，一张表一个循环。
 *
 * 为什么不用真实 HTTP 跑 68 次：慢、要端口、要 cookie 管理，而且失败时看不出是
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

/** §2.2 的路由矩阵（`logout` 是 public，不在本表；见 03 偏差 D-2；`/operator` 是 static，不进角色矩阵）。 */
export const MATRIX: readonly MatrixRow[] = [
  { method: 'GET', routePath: '/api/auth/me', path: '/api/auth/me', allow: ROLES },
  { method: 'GET', routePath: '/api/session', path: '/api/session', allow: ROLES },
  { method: 'GET', routePath: '/api/events', path: '/api/events', allow: ROLES },
  { method: 'GET', routePath: '/api/metrics', path: '/api/metrics', allow: ROLES },
  // 合流 D4：trace 仍是调试面（ROLES），生产应收窄到 auditor/admin（自评列为残余风险）
  { method: 'GET', routePath: '/api/trace', path: '/api/trace', allow: ROLES },
  // 合流：回到上一步是客户动作（审计员可以看，但不能分叉）
  {
    method: 'POST',
    routePath: '/api/session/fork',
    path: '/api/session/fork',
    allow: ['customer', 'admin'],
  },
  // 历史会话（只读，2026-11-02）：全角色可看。一进程一租户，目录里的会话都属于本租户；
  // 坐席/审计员要看"客户之前说过什么"是正当需求，没有按角色收窄的理由。
  { method: 'GET', routePath: '/api/sessions', path: '/api/sessions', allow: ROLES },
  {
    method: 'GET',
    routePath: '/api/sessions/',
    path: '/api/sessions/s-1',
    allow: ROLES,
  },
  // 合流 D3：客户专属动作——坐席不能替客户发消息 / 打断 / 放行 / 强验证
  { method: 'POST', routePath: '/api/turn', path: '/api/turn', allow: ['customer'] },
  { method: 'POST', routePath: '/api/suggest', path: '/api/suggest', allow: ['customer'] },
  { method: 'POST', routePath: '/api/interrupt', path: '/api/interrupt', allow: ['customer'] },
  {
    method: 'POST',
    routePath: '/api/approval/',
    path: '/api/approval/t-1',
    allow: ['customer'],
  },
  {
    method: 'POST',
    routePath: '/api/verify/',
    path: '/api/verify/t-1',
    allow: ['customer'],
  },
  // 01 单（ADR-0014）：改自己的交易密码是客户动作——坐席/审计员不得代改
  {
    method: 'POST',
    routePath: '/api/secure/password',
    path: '/api/secure/password',
    allow: ['customer'],
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
  {
    method: 'POST',
    routePath: '/api/handoff/message',
    path: '/api/handoff/message',
    allow: ['agent', 'admin'],
  },
  {
    method: 'POST',
    routePath: '/api/handoff/claim',
    path: '/api/handoff/claim',
    allow: ['agent', 'admin'],
  },
  {
    method: 'POST',
    routePath: '/api/handoff/heartbeat',
    path: '/api/handoff/heartbeat',
    allow: ['agent', 'admin'],
  },
  {
    method: 'GET',
    routePath: '/api/handoff/queue',
    path: '/api/handoff/queue',
    allow: ['agent', 'auditor', 'admin'],
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
  it('72 格逐格判定：允许的角色 ok，其余 403 web-forbidden', () => {
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
