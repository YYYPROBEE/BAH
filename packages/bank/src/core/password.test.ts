/**
 * 改密入参的**形状检查先于规则**（ADR-0014）。
 *
 * 只钉一件事：非字符串必须落在 `kind: 'type'` 上，不能被后面的长度规则误判成"太短"——
 * 渠道侧照 `kind` 出文案，误判会把"类型不对"提示成"密码至少 N 位"。
 */
import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { assertNewTxnPassword, DEMO_TXN_PASSWORD } from './password.ts'

describe('assertNewTxnPassword：非字符串一律先拒', () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ['undefined', undefined],
    ['null', null],
    ['number', 123456],
    ['array', ['1', '2', '3', '4', '5', '6']],
    ['object', { pin: '123456' }],
  ]

  for (const [label, value] of cases) {
    it(`${label} ⇒ password-invalid（detail.kind = type，不冒充长度问题）`, () => {
      const error = captureThrown(() => assertNewTxnPassword(value, DEMO_TXN_PASSWORD))
      expect(error.code).toBe('password-invalid')
      expect(error.detail).toMatchObject({ kind: 'type' })
    })
  }
})
