/**
 * `password` 模式与静态身份/静态画像的冲突校验（租户与鉴权 02 · TA-27）。
 *
 * 两条冲突的共同后果是**演示现场突然炸**：demoUserId 让两处绑身份、runtimeContext.user
 * 让每个 turn 因 `slots-user-mismatch` 失败（复审 AR-10）。所以它们必须是 boot 期错误。
 */

import { describe, expect, it } from 'vitest'

import type { ValidatedRow } from '../plugin-manager/index.ts'

import { assertAuthCompatibility } from './auth-compat.ts'

/** 造一行（本校验只读 `id` 与 `settings`）。 */
function row(id: string, settings: unknown = {}): ValidatedRow {
  return { id, settings } as unknown as ValidatedRow
}

const PASSWORD_WEB = row('channel:web', { auth: { mode: 'password' } })

/** 取抛出的错误码（不抛 = undefined）。 */
function codeOf(action: () => void): string | undefined {
  try {
    action()
    return undefined
  } catch (error) {
    return String((error as { code?: unknown }).code)
  }
}

describe('assertAuthCompatibility', () => {
  it('TA-27-1 password + bank:tools.demoUserId → auth-demo-user-conflict', () => {
    expect(
      codeOf(() =>
        assertAuthCompatibility([PASSWORD_WEB, row('bank:tools', { demoUserId: 'u-1' })]),
      ),
    ).toBe('auth-demo-user-conflict')
  })

  it('TA-27-2 password + core:agent.runtimeContext.user → auth-static-user-conflict', () => {
    expect(
      codeOf(() =>
        assertAuthCompatibility([
          PASSWORD_WEB,
          row('core:agent', { runtimeContext: { user: { name: '张三' } } }),
        ]),
      ),
    ).toBe('auth-static-user-conflict')
  })

  it('TA-27-3 password + runtimeContext 只有 level/notes → 放行（不是"整块禁用"）', () => {
    expect(
      codeOf(() =>
        assertAuthCompatibility([
          PASSWORD_WEB,
          row('core:agent', { runtimeContext: { level: 'gold' } }),
          row('bank:tools', {}),
        ]),
      ),
    ).toBeUndefined()
  })

  it('TA-27-4 static（缺省）下 demoUserId 与 runtimeContext.user 都合法（A3 零回归）', () => {
    expect(
      codeOf(() =>
        assertAuthCompatibility([
          row('channel:web', {}),
          row('bank:tools', { demoUserId: 'u-1' }),
          row('core:agent', { runtimeContext: { user: { name: '张三' } } }),
        ]),
      ),
    ).toBeUndefined()
  })

  it('TA-27-5 没有 channel:web 行时恒放行（headless/plan 之类不装 Web）', () => {
    expect(
      codeOf(() =>
        assertAuthCompatibility([
          row('bank:tools', { demoUserId: 'u-1' }),
          row('core:agent', { runtimeContext: { user: { name: '张三' } } }),
        ]),
      ),
    ).toBeUndefined()
  })
})
