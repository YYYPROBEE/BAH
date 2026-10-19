/**
 * 摘要-金库分离（SA-11 §3.4 / O12）。
 *
 * 事件流只存 `payloadDigest`；明文（金额、收款人、卡号等）只进 `vault_sensitive`
 * （sqlite BLOB + `key_version`）。加密用 AES-256-GCM，密钥由签名私钥派生
 * （同一密钥生命周期，滚动时 `keyVersion` 参与派生，旧行仍可按旧版本解密）。
 *
 * `@bah/persistence` 不运行时 import `@bah/saga`：这里用同 id 的结构化服务键读存储，
 * 由 host 侧把 `bah:saga-store` 实例桥接进来。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { defineService } from '@bah/core'
import { BahError, canonicalJson, sha256Hex } from '@bah/util'

import type { Context } from '@bah/core'

/** 金库只需要保存/读取窄表，结构上是 `bah:saga-store` 的子集。 */
export interface VaultStoreView {
  tx<T>(fn: (tx: VaultTxView) => T): T
}

/** `SagaTx` 的金库行原语。 */
export interface VaultTxView {
  putVault(vaultId: string, cipherText: Uint8Array, keyVersion: number, classification: string): void
  readVault(vaultId: string): VaultSensitiveView | undefined
}

/** `vault_sensitive` 行的结构视图。 */
export interface VaultSensitiveView {
  readonly vaultId: string
  readonly cipherText: Uint8Array
  readonly keyVersion: number
  readonly classification: string
}

/** 与 `bah:saga-store` 同 id，但只声明金库所需成员。 */
export const VAULT_STORE = defineService<VaultStoreView>('bah:saga-store')

/** 金库加密所需的配置子集。 */
export interface VaultSettings {
  readonly signingKeyPath: string
  readonly keyVersion: number
}

const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * 明文入金库，返回供事件流引用的 `vaultRef`。
 *
 * @throws `BahError('signing-key-missing')` 密钥文件不存在
 */
export function stashSensitive(
  ctx: Context,
  settings: VaultSettings,
  sagaId: string,
  plain: unknown,
): string {
  const vaultId = `vault:${sagaId}:${sha256Hex(canonicalJson(plain)).slice(0, 16)}`
  const key = vaultKey(settings)
  const cipherText = encryptPayload(plain, key, settings.keyVersion)
  const store = ctx.get(VAULT_STORE)
  store.tx((tx) => tx.putVault(vaultId, cipherText, settings.keyVersion, classifyOf(plain)))
  ctx.events.emit('saga/vault-accessed', {
    sagaId,
    vaultId,
    keyVersion: settings.keyVersion,
    purpose: 'stash',
  })
  return vaultId
}

/** 授权角色解密读取；每次读取都落一条 `saga/vault-accessed`。 */
export function revealSensitive(ctx: Context, settings: VaultSettings, vaultId: string): unknown {
  const store = ctx.get(VAULT_STORE)
  const row = store.tx((tx) => tx.readVault(vaultId))
  if (row === undefined) {
    throw new BahError('vault-missing', `bah-saga: vault-missing: ${vaultId}`, { vaultId })
  }
  const plain = decryptPayload(row.cipherText, vaultKey(settings, row.keyVersion), row.keyVersion)
  ctx.events.emit('saga/vault-accessed', {
    vaultId,
    keyVersion: row.keyVersion,
    purpose: 'reveal',
  })
  return plain
}

/** AES-256-GCM：`iv(12) | tag(16) | ciphertext`。 */
export function encryptPayload(plain: unknown, key: Buffer, keyVersion: number): Uint8Array {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`v${keyVersion}`, 'utf8'))
  const body = Buffer.concat([cipher.update(canonicalJson(plain), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/** 解密；认证失败抛 `vault-decrypt-failed`。 */
export function decryptPayload(cipherText: Uint8Array, key: Buffer, keyVersion: number): unknown {
  const buffer = Buffer.from(cipherText)
  if (buffer.length < IV_BYTES + TAG_BYTES) {
    throw new BahError('vault-decrypt-failed', 'bah-saga: vault-decrypt-failed: 密文长度不足')
  }
  const iv = buffer.subarray(0, IV_BYTES)
  const tag = buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buffer.subarray(IV_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(`v${keyVersion}`, 'utf8'))
    decipher.setAuthTag(tag)
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    return JSON.parse(text) as unknown
  } catch {
    throw new BahError('vault-decrypt-failed', 'bah-saga: vault-decrypt-failed: GCM 认证失败')
  }
}

/** 密钥 = scrypt(私钥 PEM, `bah-saga-vault:v<version>`)，32 字节。 */
function vaultKey(settings: VaultSettings, keyVersion = settings.keyVersion): Buffer {
  let pem: Buffer
  try {
    pem = readFileSync(settings.signingKeyPath)
  } catch {
    throw new BahError('signing-key-missing', `bah-saga: signing-key-missing: ${settings.signingKeyPath}`, {
      signingKeyPath: settings.signingKeyPath,
    })
  }
  return scryptSync(pem, `bah-saga-vault:v${keyVersion}`, 32)
}

/** 粗分类（面板按等级授权展示；细分规则属渠道侧）。 */
export function classifyOf(plain: unknown): string {
  if (typeof plain === 'object' && plain !== null) {
    const record = plain as Record<string, unknown>
    if (['cardNo', 'cvv', 'phone', 'idCard'].some((key) => record[key] !== undefined)) return 'PII'
    if (['amountCents', 'amount'].some((key) => record[key] !== undefined)) return 'FINANCIAL'
  }
  return 'SENSITIVE'
}
