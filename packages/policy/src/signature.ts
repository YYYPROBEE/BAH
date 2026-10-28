/**
 * bundle 签名（施工方案 01 §9）。
 *
 * 签的是**身份**，不是文件字节：`kind/name/version/两个摘要/engine/owners`。
 * 所以"改注释"会换 sourceDigest（签名失效），"重排 YAML" 只换 sourceDigest、
 * 语义摘要不变——两种变化都必须重新签，但原因不同。
 *
 * 算法 Ed25519（`node:crypto`，无第三方依赖）；私钥不进仓。
 */

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

import { canonicalJson } from '@bah/util'

import type { PolicyDescriptor } from './canonical.ts'
import { policyError } from './errors.ts'
import { isRecord } from './schema.ts'
import type { PolicyIr } from './table.ts'

/** `bundle.sig` 的内容。 */
export interface BundleSignature {
  readonly keyVersion: number
  readonly value: string
}

/** 待签名字节：规范化 JSON（键序稳定，跨平台一致）。 */
export function signingPayload(ir: PolicyIr, descriptor: PolicyDescriptor): string {
  return canonicalJson({
    kind: ir.kind,
    name: ir.name,
    version: ir.version,
    semanticDigest: descriptor.semanticDigest,
    sourceDigest: descriptor.sourceDigest,
    engine: { min: ir.engine.min, max: ir.engine.max },
    owners: descriptor.owners,
  })
}

/** 生成签名（base64）。 */
export function signPayload(privateKeyPem: string, payload: string): string {
  return sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64')
}

/** 验签；任何异常都当"验不过"（不区分密钥错误与签名错误，避免给攻击者信息）。 */
export function verifySignature(publicKeyPem: string, payload: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(payload, 'utf8'), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/**
 * 解析 `bundle.sig`。
 *
 * @throws `policy-signature-invalid` 形状/类型不对
 */
export function parseBundleSignature(text: string): BundleSignature {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw policyError('policy-signature-invalid', 'bundle.sig 不是合法 JSON', { file: 'bundle.sig' })
  }
  if (!isRecord(parsed) || typeof parsed['keyVersion'] !== 'number' || typeof parsed['value'] !== 'string') {
    throw policyError('policy-signature-invalid', 'bundle.sig 必须是 { keyVersion, value }', {
      file: 'bundle.sig',
    })
  }
  if (!Number.isInteger(parsed['keyVersion']) || parsed['keyVersion'] < 1 || parsed['value'].length === 0) {
    throw policyError('policy-signature-invalid', 'bundle.sig 的 keyVersion/value 非法', {
      file: 'bundle.sig',
      keyVersion: parsed['keyVersion'],
    })
  }
  return { keyVersion: parsed['keyVersion'], value: parsed['value'] }
}

/**
 * 校验签名，不通过即抛错。
 *
 * @param publicKeyPem 允许的公钥（PEM）
 * @param allowedKeyVersions 允许的密钥版本；为空表示不限制
 */
export function assertSigned(
  ir: PolicyIr,
  descriptor: PolicyDescriptor,
  signature: BundleSignature,
  publicKeyPem: string,
  allowedKeyVersions: readonly number[],
): void {
  if (allowedKeyVersions.length > 0 && !allowedKeyVersions.includes(signature.keyVersion)) {
    throw policyError(
      'policy-signature-invalid',
      `签名密钥版本 ${String(signature.keyVersion)} 不在允许列表 [${allowedKeyVersions.join(', ')}]`,
      { file: 'bundle.sig', keyVersion: signature.keyVersion },
    )
  }
  if (!verifySignature(publicKeyPem, signingPayload(ir, descriptor), signature.value)) {
    throw policyError('policy-signature-invalid', '签名验证失败（内容或密钥不匹配）', {
      file: 'bundle.sig',
      keyVersion: signature.keyVersion,
    })
  }
}
