/**
 * 主体规范化的口径用例（租户与鉴权 01 · TA-10）。
 *
 * 三条不变量各有用例：非空（空集是构造错误）、固定序（哈希稳定）、不可原地改
 * （否则审计链里的主体哈希会漂）。
 */

import { describe, expect, it } from 'vitest'

import { normalizePrincipal, hasRole, ROLES, type Role } from './principal.ts'
import { parseTenantId } from './tenant.ts'
import { BahError } from './util/errors.ts'

const TENANT = parseTenantId('demo')

/** 取错误码（非 BahError 直接让用例红）。 */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof BahError) return error.code
    throw error
  }
  throw new Error('期望抛错，但没有抛')
}

describe('normalizePrincipal', () => {
  it('TA-10-14 去重 + 按 ROLES 固定序（与传入顺序无关）', () => {
    const principal = normalizePrincipal({
      tenantId: TENANT,
      userId: 'u-1',
      roles: ['admin', 'customer', 'admin'],
      source: 'demo-config',
    })
    expect(principal.roles).toEqual(['customer', 'admin'])
    // 与 ROLES 全序一致：customer 在前、admin 在后
    expect(principal.roles).toEqual(
      ROLES.filter((role) => role === 'customer' || role === 'admin'),
    )
  })

  it('TA-10-15 同一逻辑主体的不同书写顺序 → 序列化逐字相同', () => {
    const a = normalizePrincipal({
      tenantId: TENANT,
      userId: 'u-1',
      roles: ['auditor', 'customer', 'agent'],
      source: 'mock-login',
    })
    const b = normalizePrincipal({
      tenantId: TENANT,
      userId: 'u-1',
      roles: ['customer', 'agent', 'auditor', 'customer'],
      source: 'mock-login',
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('TA-10-16 空角色集抛 principal-roles-empty（不是"无权限"）', () => {
    expect(
      codeOf(() =>
        normalizePrincipal({ tenantId: TENANT, userId: 'u-1', roles: [], source: 'demo-config' }),
      ),
    ).toBe('principal-roles-empty')
  })

  it('TA-10-17 未知角色抛 principal-role-invalid，并点名越界值', () => {
    expect(
      codeOf(() =>
        normalizePrincipal({
          tenantId: TENANT,
          userId: 'u-1',
          roles: ['customer', 'root'],
          source: 'demo-config',
        }),
      ),
    ).toBe('principal-role-invalid')
  })

  it('TA-10-18 未知来源抛 principal-source-invalid', () => {
    expect(
      codeOf(() =>
        normalizePrincipal({
          tenantId: TENANT,
          userId: 'u-1',
          roles: ['customer'],
          source: 'cookie',
        }),
      ),
    ).toBe('principal-source-invalid')
  })

  it('TA-10-19 租户运行期兜底：asTenantId 塞进来的非法值在这里被拒', () => {
    expect(
      codeOf(() =>
        normalizePrincipal({
          // 模拟调用方绕过 parseTenantId 的场景（品牌类型在运行期是 string）
          tenantId: 'Demo' as unknown as typeof TENANT,
          userId: 'u-1',
          roles: ['customer'],
          source: 'demo-config',
        }),
      ),
    ).toBe('principal-tenant-invalid')
  })

  it('TA-10-20 用户 ID：空 / 全空白 / 含分隔符一律拒绝', () => {
    for (const userId of ['', '   ', 'u/1', 'u\\1', 'u\0 1']) {
      expect(
        codeOf(() =>
          normalizePrincipal({
            tenantId: TENANT,
            userId,
            roles: ['customer'],
            source: 'demo-config',
          }),
        ),
        userId,
      ).toBe('principal-user-invalid')
    }
  })

  it('TA-10-21 用户 ID 两端空白被规范化（客户号里的空白没有语义）', () => {
    const principal = normalizePrincipal({
      tenantId: TENANT,
      userId: '  u-9  ',
      roles: ['customer'],
      source: 'demo-config',
    })
    expect(principal.userId).toBe('u-9')
  })

  it('TA-10-22 返回新对象且冻结：push / 改字段都改不动（审计哈希不漂）', () => {
    const input = { tenantId: TENANT, userId: 'u-1', roles: ['customer'] as Role[], source: 'demo-config' }
    const principal = normalizePrincipal(input)
    expect(Object.isFrozen(principal)).toBe(true)
    expect(Object.isFrozen(principal.roles)).toBe(true)
    expect(() => (principal.roles as Role[]).push('admin')).toThrow()
    expect(() => {
      ;(principal as { userId: string }).userId = 'u-2'
    }).toThrow()
    // 入参数组被 push 也不影响已产出的主体
    input.roles.push('admin')
    expect(principal.roles).toEqual(['customer'])
  })

  it('TA-10-23 hasRole 只回答渠道角色，不扩张成权限判定', () => {
    const principal = normalizePrincipal({
      tenantId: TENANT,
      userId: 'u-9',
      roles: ['agent'],
      source: 'im-map',
    })
    expect(hasRole(principal, 'agent')).toBe(true)
    expect(hasRole(principal, 'admin')).toBe(false)
  })
})
