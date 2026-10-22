/**
 * G2 依据门（施工文档 §5 第 3 步）。
 *
 * 这一道门问的不是"这条记忆对不对"，而是"**这个部署有没有资格记这么敏感的东西**"。
 *
 * 敏感级由谓词固有（`retention_basis.allowed_sensitivity`），不由数据形态推导——同一份
 * 卡尾号在 `alias_of` 语境下算 S1、在 `card_state` 语境下算 S2：前者只是称呼，后者是
 * 可用性事实。形态相同的两份数据，风险不同，这正是"按谓词定级"的理由。
 *
 * 于是本门的真实判决点是 `sensitivityCeiling`：个人客户部署 S≤2（§7.2）；把上限收到 1
 * 时 `card_state` / `subscription_state` 会被挡在门外。企业级轨按租户权限矩阵下发不同
 * 上限，就是复用这条路径。
 */

import { BASIS_BY_PREDICATE } from '../words.ts'

import type { GateResult } from '../types.ts'

/**
 * @param predicate 受控词表内的谓词
 * @param sensitivityCeiling 本部署允许的最高敏感级（个人客户默认 2）
 */
export function checkBasis(predicate: string, sensitivityCeiling: number): GateResult {
  const basis = BASIS_BY_PREDICATE.get(predicate)
  if (basis === undefined) {
    return { code: 'GATE_NO_BASIS', reason: `谓词「${predicate}」没有 retention_basis 依据行` }
  }
  if (basis.allowedSensitivity > sensitivityCeiling) {
    return {
      code: 'GATE_NO_BASIS',
      reason: `谓词「${predicate}」敏感级 S${basis.allowedSensitivity} 高于本部署上限 S${sensitivityCeiling}`,
    }
  }
  return { code: 'PASS' }
}
