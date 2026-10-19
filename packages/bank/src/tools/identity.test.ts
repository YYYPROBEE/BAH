/**
 * 会话身份绑定（施工单 09 §4 的 08 先行段）。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, captureThrown } from '@bah/test-support'

import { BANK_IDENTITY, SessionIdentityStore, restoreSessionIdentity } from './identity.ts'

const SESSION = asSessionId('s-identity')

describe('SessionIdentityStore', () => {
  it('绑定 / 解析 / 解绑；重复绑定幂等', () => {
    const store = new SessionIdentityStore()
    expect(store.resolve(SESSION)).toBeUndefined()
    store.bind(SESSION, 'u-1')
    store.bind(SESSION, 'u-1')
    expect(store.resolve(SESSION)).toBe('u-1')
    store.unbind(SESSION)
    expect(store.resolve(SESSION)).toBeUndefined()
    expect(BANK_IDENTITY.id).toBe('bank:identity')
  })

  it('空用户 ID fail-loud', () => {
    const store = new SessionIdentityStore()
    expect(captureThrown(() => store.bind(SESSION, '  ')).code).toBe('identity-invalid')
  })
})

describe('从会话日志恢复身份', () => {
  it('取最后一条 identity/bound；其他事件被忽略', () => {
    const store = new SessionIdentityStore()
    restoreSessionIdentity(store, SESSION, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'identity/bound', data: { userId: 'u-old', method: 'demo-config', at: 1 } },
      { type: 'identity/bound', data: { userId: 'u-new', method: 'mock-login', at: 2 } },
    ])
    expect(store.resolve(SESSION)).toBe('u-new')
  })

  it('没有绑定事件 / 载荷非法：保持未绑定（不伪造身份）', () => {
    const store = new SessionIdentityStore()
    restoreSessionIdentity(store, SESSION, [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'identity/bound', data: { userId: '  ' } },
      { type: 'identity/bound', data: {} },
    ])
    expect(store.resolve(SESSION)).toBeUndefined()
  })
})
