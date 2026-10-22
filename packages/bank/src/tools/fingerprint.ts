/**
 * 参数指纹（银行票据五绑定的一项）。
 *
 * 算法与运行时 **同一份实现**（`@bah/util` 的 `parameterFingerprint`）：
 * 工具名 + `canonicalJson(args)` 的 SHA-256 前 16 字节。两份实现一旦漂移，
 * 票据绑定与 guard 的键就会对不上——这类"看起来一样"的复制必须在源头收口。
 */

import { parameterFingerprint } from '@bah/util'

/** 参数指纹：`工具名:sha256(canonicalJson)[0..32]`。 */
export function fingerprintOf(name: string, args: Readonly<Record<string, unknown>>): string {
  return parameterFingerprint(name, args)
}
