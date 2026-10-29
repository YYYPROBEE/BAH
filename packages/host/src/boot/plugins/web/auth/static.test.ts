/**
 * `static` 双凭证识别（合流 2026-10-29 · T-06）。
 *
 * 钉住三件事：
 * 1. 两把 token 各自映射到**互斥**的主体与角色（客户不能打坐席、坐席不能打客户动作）；
 * 2. 未配坐席 token 时，坐席串不会被认成任何人（不能"猜对一个 token 就升级"）；
 * 3. 大小写 / 空白不改变结论（`Bearer` 前缀的解析只有一处）。
 */

import { describe, expect, it } from 'vitest'

import { parseTenantId } from '@bah/util'

import { createStaticIdentifier, STATIC_OPERATOR_USER, STATIC_WEB_USER } from './static.ts'
import { OPERATOR_TOKEN_ENV, readOperatorConfig } from '../../web-operator.ts'

const TENANT = parseTenantId('demo')
const WEB = 'tok-web'
const OP = 'tok-op'

const identify = createStaticIdentifier({ tenantId: TENANT, webToken: WEB, operatorToken: OP })

describe('createStaticIdentifier：凭证 → 主体（互斥）', () => {
  it('无凭证 / 错凭证 → undefined', () => {
    expect(identify(undefined)).toBeUndefined()
    expect(identify('')).toBeUndefined()
    expect(identify('Bearer nope')).toBeUndefined()
    expect(identify('Basic abc')).toBeUndefined()
  })

  it('客户凭证 → svc:web / customer', () => {
    const principal = identify(`Bearer ${WEB}`)
    expect(principal?.userId).toBe(STATIC_WEB_USER)
    expect(principal?.roles).toEqual(['customer'])
    expect(principal?.tenantId).toBe(TENANT)
  })

  it('坐席凭证 → svc:operator / agent', () => {
    const principal = identify(`Bearer ${OP}`)
    expect(principal?.userId).toBe(STATIC_OPERATOR_USER)
    expect(principal?.roles).toEqual(['agent'])
  })

  it('未配坐席 token 时，坐席串不被认成任何人', () => {
    const onlyWeb = createStaticIdentifier({
      tenantId: TENANT,
      webToken: WEB,
      operatorToken: undefined,
    })
    expect(onlyWeb(`Bearer ${OP}`)).toBeUndefined()
    expect(onlyWeb(`Bearer ${WEB}`)?.userId).toBe(STATIC_WEB_USER)
  })

  it('Bearer 前缀大小写不敏感（解析只有一处）', () => {
    expect(identify(`bearer ${WEB}`)?.userId).toBe(STATIC_WEB_USER)
    expect(identify(`  Bearer ${OP}  `)?.userId).toBe(STATIC_OPERATOR_USER)
  })

  it('两个 token 相同：`readOperatorConfig` 在 boot 期拒绝（这里不静默）', () => {
    let code: string | undefined
    try {
      readOperatorConfig({ [OPERATOR_TOKEN_ENV]: WEB }, WEB)
    } catch (error) {
      code = (error as { code?: string }).code
    }
    expect(code).toBe('web-operator-token-conflict')
  })
})
