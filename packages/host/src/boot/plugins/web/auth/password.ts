/**
 * 口令哈希（租户与鉴权 02 · TA-21）：scrypt + `timingSafeEqual`，纯函数。
 *
 * ## 五条纪律
 *
 * 1. **异步 `scrypt`，不用 `scryptSync`**：Node 单线程，一次 16 MiB 的 scrypt 会把
 *    SSE 心跳（15 s 一次）一起卡住。登录是交互路径，不能吃满事件循环。
 * 2. **显式 `maxmem: 64 MiB`**：Node 默认 32 MiB，`N=16384,r=8` 需要约 16 MiB——
 *    看起来够，但一旦有人把 `N` 调大就直接 `ERR_CRYPTO_INVALID_SCRYPT_PARAM`。
 * 3. **编码串自带参数**：`scrypt$<N>$<r>$<p>$<b64salt>$<b64hash>`，改参数不用重算旧口令
 *    （验的时候按串里的参数算）。
 * 4. **`timingSafeEqual` 前先比长度**：长度不等它会抛 `RangeError`，
 *    而抛错与返回 false 的耗时不同——那也是一条侧信道。
 * 5. **口令永不进日志/错误 detail/响应体**：本文件不产生任何包含明文的消息。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/**
 * `scrypt` 的 Promise 包装。
 *
 * 不用 `promisify(scrypt)`：其类型重载只认 3 个参数，而我们必须显式传 `maxmem`。
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  params: { readonly N: number; readonly r: number; readonly p: number },
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keylen, { ...params, maxmem: MAXMEM }, (error, derived) => {
      if (error !== null) reject(error)
      else resolve(derived)
    })
  })
}

/** scrypt 参数（改它会让旧编码串按串内参数验，不会失效）。 */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 } as const

/** scrypt 需要的最大内存（显式给，避免 Node 默认 32 MiB 的隐形上限）。 */
const MAXMEM = 64 * 1024 * 1024

/**
 * 固定 dummy 哈希（"用户不存在"时也跑一次，抹平耗时差）。
 *
 * 由固定盐 + 一个随机丢弃的口令在开发时算一次写死；**它不代表任何真实账户**，
 * `verifyPassword` 对它只会返回 false。
 */
export const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU'

/** 解析后的编码串。 */
interface ParsedHash {
  readonly N: number
  readonly r: number
  readonly p: number
  readonly salt: Buffer
  readonly hash: Buffer
}

/**
 * 解析 `scrypt$N$r$p$salt$hash`。
 *
 * @returns 形状不对时 `undefined`（调用方决定"算失败"还是"告警"）
 */
export function parseEncodedHash(encoded: string): ParsedHash | undefined {
  const parts = encoded.split('$')
  if (parts.length !== 6) return undefined
  const [scheme, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if (scheme !== 'scrypt') return undefined
  const N = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return undefined
  if (N < 2 || r < 1 || p < 1) return undefined
  const salt = Buffer.from(rawSalt, 'base64')
  const hash = Buffer.from(rawHash, 'base64')
  if (salt.length === 0 || hash.length === 0) return undefined
  return { N, r, p, salt, hash }
}

/** 算一个哈希（参数/盐可注入 → 测试可确定性）。 */
export async function hashPassword(
  plain: string,
  params: { readonly N?: number; readonly r?: number; readonly p?: number; readonly keylen?: number } = {},
  salt?: Buffer,
): Promise<string> {
  const N = params.N ?? SCRYPT_PARAMS.N
  const r = params.r ?? SCRYPT_PARAMS.r
  const p = params.p ?? SCRYPT_PARAMS.p
  const keylen = params.keylen ?? SCRYPT_PARAMS.keylen
  const usedSalt = salt ?? randomBytes(SCRYPT_PARAMS.saltBytes)
  const derived = await scryptAsync(plain.normalize('NFC'), usedSalt, keylen, { N, r, p })
  return `scrypt$${String(N)}$${String(r)}$${String(p)}$${usedSalt.toString('base64')}$${derived.toString('base64')}`
}

/**
 * 校验口令。
 *
 * 坏编码串 → `false`（不抛：一个坏掉的目录不该把登录接口打成 500）+ 一条 warn。
 */
export async function verifyPassword(plain: string, encoded: string): Promise<boolean> {
  const parsed = parseEncodedHash(encoded)
  if (parsed === undefined) {
    console.warn('[web-auth] 口令编码串非法（期望 scrypt$N$r$p$salt$hash）；该账户无法登录')
    return false
  }
  const derived = await scryptAsync(plain.normalize('NFC'), parsed.salt, parsed.hash.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
  })
  if (derived.length !== parsed.hash.length) return false
  return timingSafeEqual(derived, parsed.hash)
}

/**
 * 跑一次"注定失败"的校验（用户不存在时用），耗时与真校验同形。
 *
 * 为什么单独一个函数：调用方不该知道 dummy 的细节；也防止有人"优化"掉这次调用。
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  await verifyPassword(plain, DUMMY_HASH)
  return false
}
