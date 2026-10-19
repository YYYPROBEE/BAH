/**
 * Ed25519 签名与密钥纪律（SA-11 §3.3 / M6'）。
 *
 * 只用 `node:crypto`；密钥文件必须 600（Windows 无 POSIX 600 语义，按平台豁免并如实标注）。
 * 密钥访问审计由调用方注入 `onAccess`，保证「一次操作只读一次、只落一条聚合事件」。
 */

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

import { BahError } from '@bah/util'

/** 一对已载入的 Ed25519 密钥（同一操作内复用）。 */
export interface SigningKeys {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
}

/** 密钥访问回调（聚合口径：同一次操作只调一次）。 */
export type KeyAccessHook = (purpose: string, count: number) => void

/**
 * 载入私钥（同时派生公钥）。
 *
 * @throws `BahError('signing-key-missing')` 文件不存在
 * @throws `BahError('signing-key-permission')` 非 600（仅 POSIX）
 */
export function loadSigningKeys(
  signingKeyPath: string,
  purpose: string,
  count: number,
  onAccess?: KeyAccessHook,
): SigningKeys {
  let mode: number
  try {
    mode = statSync(signingKeyPath).mode & 0o777
  } catch {
    throw new BahError('signing-key-missing', `bah-saga: signing-key-missing: ${signingKeyPath}`, {
      signingKeyPath,
    })
  }

  // Windows 没有 POSIX 权限位：stat.mode 是合成值，不能据此拒绝（SA-11 §3.3 豁免口径）。
  if (process.platform !== 'win32' && mode !== 0o600) {
    throw new BahError(
      'signing-key-permission',
      `bah-saga: signing-key-permission: 密钥文件必须是 600（当前 ${mode.toString(8)}）`,
      { signingKeyPath, mode },
    )
  }

  if (count > 0) onAccess?.(purpose, count)
  const pem = readFileSync(signingKeyPath)
  const privateKey = createPrivateKey(pem)
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

/** 对 `recordHash` 的 UTF-8 字节签名，返回 base64。 */
export function signRecord(keys: SigningKeys, recordHash: string): string {
  return sign(null, Buffer.from(recordHash, 'utf8'), keys.privateKey).toString('base64')
}

/** 验签。 */
export function verifyRecord(keys: SigningKeys, recordHash: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(recordHash, 'utf8'), keys.publicKey, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}
