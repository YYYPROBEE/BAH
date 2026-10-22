/**
 * 工具参数指纹（票据五绑定 / 单调 guard / `tool/call` 落账共用）。
 *
 * 口径：`工具名 + SHA-256(canonicalJson(args)) 前 16 字节`。
 * - 定长：不会随参数体积无界增长；
 * - 不可逆：审计日志与票据账本读不出原始参数（原始参数只在 `tool/call.args` 一处）；
 * - 键序无关：复用 `canonicalJson` 的确定性排序，同一份参数只有一个指纹。
 */

import { canonicalJson, sha256Hex } from './canonical.ts'

/** 指纹保留的十六进制字符数（16 字节 = 32 个 hex 字符）。 */
export const FINGERPRINT_HEX_LENGTH = 32

/**
 * 参数指纹。
 *
 * @throws `BahError('invalid-canonical-json')` 参数含非有限数 / 循环引用等不可稳定序列化的形态
 */
export function parameterFingerprint(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string {
  return `${tool}:${sha256Hex(canonicalJson(args)).slice(0, FINGERPRINT_HEX_LENGTH)}`
}
