/**
 * 授权判定树（03 TA-41）：7 条主判据 + 3 条组合。
 *
 * 为什么用纯函数测：判定树的语义是"顺序即安全"。起 HTTP 服务会把
 * "授权错了"和"服务没起来"混成同一个失败；这里每个格子 1 毫秒，失败信息直接是判定树节点。
 */

import { describe, expect, it } from 'vitest'

import { normalizePrincipal, parseTenantId, type Role } from '@bah/util'

import type { AuthSession } from '../auth/session-store.ts'
import type { RequestIdentity } from '../auth/identity.ts'
import { authorize } from './authorize.ts'

const TENANT = parseTenantId('demo')

/** 造一个主体身份（`session` 只占位：authorize 不读它）。 */
function principalOf(roles: readonly Role[]): RequestIdentity {
  const principal = normalizePrincipal({
    tenantId: TENANT,
    userId: 'u-1',
    roles,
    source: 'session-auth',
  })
  const session: AuthSession = {
    sid: 'sid-1',
    tenantId: TENANT,
    userId: 'u-1',
    roles,
    csrf: 'csrf-1',
    issuedAt: 0,
    lastSeenAt: 0,
    absoluteExpiresAt: 1_000,
  }
  return { kind: 'principal', principal, session }
}

/** 合成服务主体（static / none 模式）。 */
function serviceOf(): RequestIdentity {
  return {
    kind: 'service',
    principal: normalizePrincipal({
      tenantId: TENANT,
      userId: 'svc:web',
      roles: ['customer', 'agent', 'auditor'],
      source: 'demo-config',
    }),
  }
}

const ANONYMOUS: RequestIdentity = { kind: 'anonymous' }

/** 调一次判定（默认非 API 路径）。 */
function judge(
  identity: RequestIdentity,
  spec: { auth: 'public' | 'admin' | 'web' | 'static'; roles?: readonly Role[] },
  isApi = true,
): ReturnType<typeof authorize> {
  return authorize({ identity, spec, method: 'GET', path: '/api/x', isApi })
}

describe('TA-41 · 判定树（顺序即语义）', () => {
  it('TA-41-1 public：匿名放行（登录/登出/探活没有主体）', () => {
    expect(judge(ANONYMOUS, { auth: 'public' })).toEqual({ ok: true })
  })

  it('TA-41-2 admin：放行（token + 回环在 guardAdmin，不在这里重验）', () => {
    expect(judge(ANONYMOUS, { auth: 'admin' })).toEqual({ ok: true })
  })

  it('TA-41-3 static：非 API 路径匿名放行（打开页面不需要登录）', () => {
    expect(judge(ANONYMOUS, { auth: 'static' }, false)).toEqual({ ok: true })
  })

  it('TA-41-4 web + 匿名 → 401（不是 403：403 不能代替"你没登录"）', () => {
    const verdict = judge(ANONYMOUS, { auth: 'web', roles: ['customer'] })
    expect(verdict).toEqual({
      ok: false,
      status: 401,
      code: 'web-unauthorized',
      reason: '缺少或错误的访问凭证',
    })
  })

  it('TA-41-5 角色无交集 → 403 web-forbidden，且不回显主体角色', () => {
    const verdict = judge(principalOf(['auditor']), { auth: 'web', roles: ['customer', 'admin'] })
    expect(verdict).toMatchObject({ ok: false, status: 403, code: 'web-forbidden' })
    if (verdict.ok) return
    expect(verdict.reason).toContain('customer')
    expect(verdict.reason).not.toContain('auditor')
  })

  it('TA-41-6 角色有交集 → 放行（多角色任一命中）', () => {
    expect(judge(principalOf(['customer', 'agent']), { auth: 'web', roles: ['agent'] })).toEqual({
      ok: true,
    })
  })

  it('TA-41-7 web 未声明 roles → 已认证即放行（默认拒绝匿名，不是全放行）', () => {
    expect(judge(serviceOf(), { auth: 'web' })).toEqual({ ok: true })
    expect(judge(ANONYMOUS, { auth: 'web' })).toMatchObject({ ok: false, status: 401 })
  })

  it('TA-41-8 static 命中 API 未知路径 + 匿名 → 401（未知 API 不是免鉴权探测）', () => {
    expect(judge(ANONYMOUS, { auth: 'static' }, true)).toMatchObject({
      ok: false,
      status: 401,
    })
  })

  it('TA-41-9 static 命中 API 未知路径 + 已认证 → 放行（让 404/405 决定结果）', () => {
    expect(judge(serviceOf(), { auth: 'static' }, true)).toEqual({ ok: true })
  })

  it('TA-41-10 scope:self 是声明式：判定不读它，也不改输入', () => {
    const identity = principalOf(['customer'])
    const spec = { auth: 'web' as const, roles: ['customer'] as const, scope: 'self' as const }
    const snapshot = JSON.stringify({ identity, spec })
    expect(
      authorize({ identity, spec, method: 'POST', path: '/api/approval/t-1', isApi: true }),
    ).toEqual({ ok: true })
    expect(JSON.stringify({ identity, spec })).toBe(snapshot)
  })
})

describe('TA-41 · 组合（顺序不能换）', () => {
  it('public + 匿名 → 放行（身份检查在 public 之后）', () => {
    expect(judge(ANONYMOUS, { auth: 'public', roles: undefined })).toEqual({ ok: true })
  })

  it('admin + 匿名 → 放行（管理面在 authorize 之外判）', () => {
    expect(judge(ANONYMOUS, { auth: 'admin', roles: undefined })).toEqual({ ok: true })
  })

  it('web + 匿名 + 有 roles → 401 优先于 403', () => {
    expect(judge(ANONYMOUS, { auth: 'web', roles: ['admin'] })).toMatchObject({
      ok: false,
      status: 401,
      code: 'web-unauthorized',
    })
  })
})
