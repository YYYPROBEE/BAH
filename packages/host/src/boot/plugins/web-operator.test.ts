/**
 * 坐席凭证与身份解析（HO-4）单测。
 *
 * 钉住：两个 token 的优先级与隔离、长度不等的失败路径、显示名的默认/上限、
 * 以及"两 token 相同 = 启动失败"这条安全红线。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import {
  DEFAULT_OPERATOR_NAME,
  MAX_OPERATOR_NAME,
  OPERATOR_NAME_ENV,
  OPERATOR_TOKEN_ENV,
  presentedPrincipal,
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

describe('presentedPrincipal：六条分支', () => {
  const tokens = { webToken: WEB, operatorToken: OP }

  it('无凭证 → undefined', () => {
    expect(presentedPrincipal({}, null, tokens)).toBeUndefined()
    expect(presentedPrincipal({ authorization: '' }, null, tokens)).toBeUndefined()
    expect(presentedPrincipal({ authorization: 'Basic abc' }, null, tokens)).toBeUndefined()
  })

  it('错 token → undefined', () => {
    expect(presentedPrincipal({ authorization: 'Bearer nope' }, null, tokens)).toBeUndefined()
  })

  it('客户凭证 → user', () => {
    expect(presentedPrincipal({ authorization: `Bearer ${WEB}` }, null, tokens)).toBe('user')
  })

  it('坐席凭证 → operator（先比 operator）', () => {
    expect(presentedPrincipal({ authorization: `Bearer ${OP}` }, null, tokens)).toBe('operator')
  })

  it('两个都配但传错 → undefined', () => {
    expect(presentedPrincipal({ authorization: 'Bearer bothtokens' }, null, tokens)).toBeUndefined()
  })

  it('SSE 的 query token 同样生效（坐席与客户）', () => {
    expect(presentedPrincipal({}, OP, tokens)).toBe('operator')
    expect(presentedPrincipal({}, WEB, tokens)).toBe('user')
  })

  it('未配坐席 token 时，坐席串不会被认成任何人', () => {
    expect(presentedPrincipal({ authorization: `Bearer ${OP}` }, null, { webToken: WEB, operatorToken: undefined })).toBeUndefined()
  })
})
