/**
 * G3 敏感门（设计文档 §4.4 / §5）。
 *
 * 三条 PII 规则，处置方式**不同**——这是本门最容易被写错的地方：
 *
 * | 形态 | 处置 | 为什么 |
 * |---|---|---|
 * | 身份证（18 位） | 拒收 | 一旦落库就是不可撤销的强标识，脱敏也留痕 |
 * | 完整卡号（16–19 位） | 收敛为尾 4 位 | 业务只需要尾号，多存一位都是负债 |
 * | 手机号 | 前 3 + `****` + 后 4 | 收款人场景需要人可辨识 |
 *
 * 手机号规则本轮没有生效面（词表里没有存手机号的谓词），保留是为了收款人变体接入时
 * 不必回头改门——**已知并登记**，而不是藏起来当"已实现"。
 */

import type { GateResult, MemoryCandidate } from '../types.ts'

/** 18 位身份证（末位可为 X）。 */
const ID_CARD = /\b\d{17}[\dXx]\b/

/** 完整卡号：16–19 位连续数字。 */
const FULL_CARD = /\b\d{16,19}\b/

export interface SensitivityVerdict {
  readonly result: GateResult
  /** 脱敏后的 object（仅在完整卡号命中时与入参不同）。 */
  readonly object: unknown
}

/**
 * @param candidate 已过 G1 的候选
 */
export function checkSensitivity(candidate: MemoryCandidate): SensitivityVerdict {
  const text = candidate.rawSpan

  if (ID_CARD.test(text)) {
    return {
      // 拒收，不是脱敏：身份证号进了记忆库就再也解释不清"为什么记了它"。
      result: { code: 'GATE_SENSITIVITY', reason: '命中身份证号（S3），拒绝写入' },
      object: candidate.object,
    }
  }

  const fullCard = text.match(FULL_CARD)
  if (fullCard !== null) {
    const digits = fullCard[0]
    const last4 = digits.slice(-4)
    return {
      result: { code: 'PASS', reason: '完整卡号已收敛为尾 4 位' },
      object: { card_last4: last4 },
    }
  }

  return { result: { code: 'PASS' }, object: candidate.object }
}
