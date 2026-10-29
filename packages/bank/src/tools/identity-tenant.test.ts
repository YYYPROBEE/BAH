/**
 * 身份绑定的租户（租户与鉴权 01 · TA-13b）。
 *
 * 绑定要记"在哪个租户下绑的"，恢复时租户**取自调用方**（日志所在目录即租户），
 * 不从 `identity/bound` 载荷里读——载荷里再写一份是第二真相源，而旧日志根本没有那个字段。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'

import { SessionIdentityStore, restoreSessionIdentity } from './identity.ts'

describe('SessionIdentityStore · tenantId', () => {
  it('TA-13b-1 bind 带租户 → resolveIdentity 能取到；resolve 仍只给 userId（兼容旧调用）', () => {
    const store = new SessionIdentityStore()
    store.bind(asSessionId('s-1'), 'u-1', 'demo')
    expect(store.resolveIdentity(asSessionId('s-1'))).toEqual({ userId: 'u-1', tenantId: 'demo' })
    expect(store.resolve(asSessionId('s-1'))).toBe('u-1')
  })

  it('TA-13b-2 不带租户的旧式绑定：tenantId 缺省（不是空串、不是 undefined 落盘）', () => {
    const store = new SessionIdentityStore()
    store.bind(asSessionId('s-2'), 'u-2')
    expect(store.resolveIdentity(asSessionId('s-2'))).toEqual({ userId: 'u-2' })
    expect(store.resolveIdentity(asSessionId('s-2'))).not.toHaveProperty('tenantId')
  })

  it('TA-13b-3 未绑定 → undefined（不是空对象）', () => {
    const store = new SessionIdentityStore()
    expect(store.resolveIdentity(asSessionId('s-none'))).toBeUndefined()
    expect(store.resolve(asSessionId('s-none'))).toBeUndefined()
  })
})

describe('restoreSessionIdentity · 租户来自当前进程', () => {
  it('TA-13b-4 旧载荷（无 tenantId）恢复后带上当前租户，不抛错（老日志照常回放）', () => {
    const store = new SessionIdentityStore()
    restoreSessionIdentity(
      store,
      asSessionId('s-3'),
      [{ type: 'identity/bound', data: { userId: 'u-3', method: 'demo-config', at: 1 } }],
      'acme',
    )
    expect(store.resolveIdentity(asSessionId('s-3'))).toEqual({ userId: 'u-3', tenantId: 'acme' })
  })

  it('TA-13b-5 最后一条绑定生效（与 bind 的覆盖语义一致）', () => {
    const store = new SessionIdentityStore()
    restoreSessionIdentity(
      store,
      asSessionId('s-4'),
      [
        { type: 'identity/bound', data: { userId: 'u-old', method: 'demo-config', at: 1 } },
        { type: 'other/event', data: {} },
        { type: 'identity/bound', data: { userId: 'u-new', method: 'mock-login', at: 2 } },
      ],
      'demo',
    )
    expect(store.resolveIdentity(asSessionId('s-4'))).toEqual({ userId: 'u-new', tenantId: 'demo' })
  })
})
