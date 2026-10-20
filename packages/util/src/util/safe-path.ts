/**
 * 路径段白名单（会话 ID / 链 ID 等「会拼进文件路径的标识符」）。
 *
 * 为什么必须集中：`join(root, id)` 对 `../` 不做任何拦截，一个来自参数/模型的
 * 标识符就能在根目录之外创建目录并写文件。所有拼路径的入口必须先过这里。
 */

import { BahError } from './errors.ts'

/** 允许的标识符：字母数字开头，后续只允许字母数字、点、下划线、连字符。 */
export const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 是否是合法路径段（拒绝空串、`..`、`.`、绝对路径、分隔符与 NUL）。 */
export function isSafePathSegment(value: string): boolean {
  return (
    SAFE_PATH_SEGMENT.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0')
  )
}

/**
 * 断言路径段合法。
 *
 * @throws `BahError('invalid-path-segment')` 含 `/`、`\`、`..`、NUL 或空串
 */
export function assertSafePathSegment(value: string, what: string): void {
  if (isSafePathSegment(value)) return
  throw new BahError(
    'invalid-path-segment',
    `${what} 不是合法的路径段（只允许字母数字 . _ -，且不能是 . / ..）：${JSON.stringify(value)}`,
    { what, value },
  )
}
