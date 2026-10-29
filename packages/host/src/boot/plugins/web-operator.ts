/**
 * 坐席凭证与身份解析（HO-4，纯函数）。
 *
 * 照 `web-admin.ts` 的成熟范式：读 env、定长比较、不做 HTTP。
 *
 * ## 三条硬约束
 *
 * 1. **默认关闭**：没设 `BAH_OPERATOR_TOKEN` 就没有坐席面（`auth:'operator'` 路由一律 404）；
 * 2. **客户与坐席凭证必须分离**：两个 env 相同 ⇒ 启动失败（否则客户页 token 会被判成坐席）；
 * 3. **显示名不是凭证**：`BAH_OPERATOR_NAME` 只进审计与气泡，身份由 token 证明。
 */

import { timingSafeEqual } from 'node:crypto'

import { BahError } from '@bah/util'

import { presentedWebToken } from './web-auth.ts'

/** 坐席 token 的环境变量名（只此一处）。 */
export const OPERATOR_TOKEN_ENV = 'BAH_OPERATOR_TOKEN'

/** 坐席显示名的环境变量名（只此一处）。 */
export const OPERATOR_NAME_ENV = 'BAH_OPERATOR_NAME'

/** 未配置显示名时的缺省值。 */
export const DEFAULT_OPERATOR_NAME = '坐席'

/** 显示名上限（字符）。 */
export const MAX_OPERATOR_NAME = 64

/** 请求者身份。 */
export type Principal = 'user' | 'operator'

/** 坐席配置（`web.ts` 装配一次，进 `deps`）。 */
export interface OperatorConfig {
  readonly token: string | undefined
  readonly name: string
}

/**
 * 读坐席 token。
 *
 * @returns 未设置或全空白 → `undefined`（调用方据此让坐席面整体 404）
 */
export function readOperatorToken(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = env[OPERATOR_TOKEN_ENV]
  if (raw === undefined) return undefined
  const token = raw.trim()
  return token === '' ? undefined : token
}

/**
 * 读坐席显示名（缺省 `坐席`）。
 *
 * @throws `BahError('web-operator-name-invalid')` 超过 64 字符
 */
export function readOperatorName(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env[OPERATOR_NAME_ENV]
  const name = raw === undefined ? '' : raw.trim()
  if (name === '') return DEFAULT_OPERATOR_NAME
  if ([...name].length > MAX_OPERATOR_NAME) {
    throw new BahError(
      'web-operator-name-invalid',
      `${OPERATOR_NAME_ENV} 不得超过 ${String(MAX_OPERATOR_NAME)} 字符`,
    )
  }
  return name
}

/**
 * 一次读完坐席配置，并拒绝"两个凭证相同"的部署错误。
 *
 * @throws `BahError('web-operator-token-conflict')` 两个 token 相同
 */
export function readOperatorConfig(
  env: Readonly<Record<string, string | undefined>>,
  webToken: string,
): OperatorConfig {
  const token = readOperatorToken(env)
  if (token !== undefined && token === webToken) {
    throw new BahError(
      'web-operator-token-conflict',
      `${OPERATOR_TOKEN_ENV} 不能与 web token 相同（否则客户页凭证会被判成坐席）`,
    )
  }
  return { token, name: readOperatorName(env) }
}

/**
 * 判定出示的凭证属于谁。
 *
 * 顺序：先比 operator（更强），再比 user。两者都用 `timingSafeEqual`，
 * 且**长度不等时也走一次比较**（避免用长度侧信道区分"token 对了一半"）。
 *
 * @returns 未带凭证或都不匹配 → `undefined`
 */
export function presentedPrincipal(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  queryToken: string | null | undefined,
  tokens: { readonly webToken: string; readonly operatorToken: string | undefined },
): Principal | undefined {
  const presented = bearerOf(headers, queryToken)
  if (presented === undefined) return undefined
  if (tokens.operatorToken !== undefined && secretEqual(tokens.operatorToken, presented)) {
    return 'operator'
  }
  if (secretEqual(tokens.webToken, presented)) return 'user'
  return undefined
}

/** 从 `Authorization` / SSE 的 `?token=` 里取出 Bearer 后的裸 token。 */
function bearerOf(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  queryToken: string | null | undefined,
): string | undefined {
  const authorization = presentedWebToken(headers, queryToken)
  if (authorization === undefined) return undefined
  // 剥前缀用 slice 而不是 replace：`replace` 会把 token 内部的 "Bearer " 也换掉
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  const presented = match?.[1]?.trim()
  return presented === undefined || presented === '' ? undefined : presented
}

/** 定长比较；长度不等也做一次同长比较再返回 false（不让提前 return 成为计时侧信道）。 */
function secretEqual(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(presented, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(Buffer.alloc(right.length), Buffer.alloc(right.length))
    return false
  }
  return timingSafeEqual(left, right)
}
