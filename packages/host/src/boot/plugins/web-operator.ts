/**
 * 坐席凭证与显示名（HO-4，纯函数）。
 *
 * 照 `web-admin.ts` 的成熟范式：读 env、定长比较、不做 HTTP。
 *
 * ## 三条硬约束
 *
 * 1. **默认关闭**：没设 `BAH_OPERATOR_TOKEN` 就没有坐席面（坐席路由一律 404）；
 * 2. **客户与坐席凭证必须分离**：两个 env 相同 ⇒ 启动失败（否则客户页 token 会被判成坐席）；
 * 3. **显示名不是凭证**：`BAH_OPERATOR_NAME` 只进审计与气泡，身份由 token 证明。
 *
 * ## 合流 2026-10-29（T-06.3）
 *
 * 临时的 `Principal = 'user' | 'operator'` 与 `presentedPrincipal` 已删除：
 * 凭证 → 主体的映射只在 `web/auth/static.ts` 一处（`svc:web` / `svc:operator`），
 * 本文件只保留"读配置"与"定长比较"两件事，避免出现第二份身份真相。
 */

import { timingSafeEqual } from 'node:crypto'

import { BahError } from '@bah/util'

/** 坐席 token 的环境变量名（只此一处）。 */
export const OPERATOR_TOKEN_ENV = 'BAH_OPERATOR_TOKEN'

/** 坐席显示名的环境变量名（只此一处）。 */
export const OPERATOR_NAME_ENV = 'BAH_OPERATOR_NAME'

/** 未配置显示名时的缺省值。 */
export const DEFAULT_OPERATOR_NAME = '坐席'

/** 显示名上限（字符）。 */
export const MAX_OPERATOR_NAME = 64

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
 * 定长比较；长度不等也做一次同长比较再返回 false（不让提前 return 成为计时侧信道）。
 *
 * 调用方：`web/auth/static.ts`（两次凭证比对）与 `web-admin.ts` 的同类判定。
 */
export function secretEqual(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(presented, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(Buffer.alloc(right.length), Buffer.alloc(right.length))
    return false
  }
  return timingSafeEqual(left, right)
}
