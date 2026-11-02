/**
 * 坐席凭证与显示名（HO-4）单测。
 *
 * 钉住：显示名的默认/上限、以及"两 token 相同 = 启动失败"这条安全红线。
 * 凭证 → 主体的映射（双凭证）在 `web/auth/static.test.ts`——本文件只管"读配置"。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import {
  DEFAULT_OPERATOR_NAME,
  MAX_OPERATOR_NAME,
  OPERATOR_NAME_ENV,
  OPERATOR_TOKEN_ENV,
  readOperatorConfig,
  readOperatorName,
  readOperatorToken,
} from './web-operator.ts'

const WEB = 'web-token'
const OP = 'operator-token'

describe('readOperatorToken / readOperatorName', () => {
  it('未设置 / 全空白 → undefined / 缺省名', () => {
    expect(readOperatorToken({})).toBeUndefined()
    expect(readOperatorToken({ [OPERATOR_TOKEN_ENV]: '   ' })).toBeUndefined()
    expect(readOperatorName({})).toBe(DEFAULT_OPERATOR_NAME)
    expect(readOperatorName({ [OPERATOR_NAME_ENV]: '   ' })).toBe(DEFAULT_OPERATOR_NAME)
  })

  it('trim 后返回；显示名超长 → web-operator-name-invalid', () => {
    expect(readOperatorToken({ [OPERATOR_TOKEN_ENV]: ' op ' })).toBe('op')
    expect(readOperatorName({ [OPERATOR_NAME_ENV]: ' 坐席小周 ' })).toBe('坐席小周')
    const error = captureThrown(() =>
      readOperatorName({ [OPERATOR_NAME_ENV]: 'x'.repeat(MAX_OPERATOR_NAME + 1) }),
    )
    expect((error as { code?: string }).code).toBe('web-operator-name-invalid')
  })
})

describe('readOperatorConfig：客户与坐席凭证必须分离', () => {
  it('两个 token 相同 → web-operator-token-conflict', () => {
    const error = captureThrown(() =>
      readOperatorConfig({ [OPERATOR_TOKEN_ENV]: WEB }, WEB),
    )
    expect((error as { code?: string }).code).toBe('web-operator-token-conflict')
  })

  it('不同 / 未配置 → 正常返回', () => {
    expect(readOperatorConfig({ [OPERATOR_TOKEN_ENV]: OP }, WEB)).toEqual({
      token: OP,
      name: DEFAULT_OPERATOR_NAME,
    })
    expect(readOperatorConfig({}, WEB)).toEqual({ token: undefined, name: DEFAULT_OPERATOR_NAME })
  })
})
