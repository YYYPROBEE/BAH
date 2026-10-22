/**
 * 幂等键与 nonce（SA-09 §3.1 / O1 / M3）。
 *
 * 最终键 = `${namespace}:hmac_sha256(nonce, `${sagaId}|${localId}`)`。
 * nonce 必须来自 `node:crypto` 随机源（128bit），**绝不能**用 seededRandom：
 * 可预测的 nonce 等于允许占位攻击（M3/A13）。nonce 在 PLAN 期持久化，
 * 恢复时从 `saga_step.idempotency_nonce` 读回重建键。
 */

import { createHmac, randomBytes } from 'node:crypto'

import type { IdemNamespace, IdempotencyRecord } from '../types.ts'

/** 128bit 不可预测 nonce（hex）。 */
export function makeNonce(): string {
  return randomBytes(16).toString('hex')
}

/** 双键：仅命名空间不同，同一 (sagaId, localId, nonce) 得到两个不同键。 */
export function makeKey(
  namespace: IdemNamespace,
  sagaId: string,
  localId: string,
  nonce: string,
): string {
  const mac = createHmac('sha256', nonce).update(`${sagaId}|${localId}`, 'utf8').digest('hex')
  return `${namespace}:${mac}`
}

/** PLAN 期物化幂等记录种子（恢复期重建键的确定性来源）。 */
export function seed(
  namespace: IdemNamespace,
  sagaId: string,
  localId: string,
  nonce: string,
  toolName: string,
  requestDigest: string,
): IdempotencyRecord {
  return {
    idemKey: makeKey(namespace, sagaId, localId, nonce),
    namespace,
    sagaId,
    targetSystem: toolName,
    requestDigest,
    status: 'RESERVED',
  }
}
