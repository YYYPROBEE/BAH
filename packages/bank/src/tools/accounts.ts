/**
 * 账户与身份解析。
 *
 * 纪律：**绝不隐式使用默认账户**。身份由 `BankIdentity` 给出（09 落地为会话绑定；
 * 08 的 headless 演示由 profile 显式配置 `demoUserId`），没有身份就抛 `no-identity`。
 * 账户归属在工具边界再核一遍——`bankCore.balance(accountId)` 本身不校验用户。
 */

import { BahError } from '@bah/util'

import type { SessionId } from '@bah/core'

import type { Account } from '../core/model.ts'
import { bankIds } from '../core/model.ts'
import type { BankIdentity, BankToolDeps } from './types.ts'

export type { BankIdentity } from './types.ts'

/**
 * 取当前会话的用户 ID。
 *
 * @throws `BahError('no-identity')` 会话未绑定身份
 */
export function requireUserId(deps: BankToolDeps, sessionId: SessionId): string {
  const userId = deps.identity.resolve(sessionId)
  if (userId === undefined || userId.trim().length === 0) {
    throw new BahError(
      'no-identity',
      'bank-tools: 当前会话未绑定银行用户身份（业务工具一律拒绝）',
      { sessionId },
    )
  }
  return userId
}

/**
 * 解析账户：显式 ID 必须属于当前用户；缺省取主账户（活期，ID 最小者）。
 *
 * @throws `BahError('account-forbidden')` 账户不属于该用户
 * @throws `BahError('account-unknown')` 用户没有任何账户
 */
export async function requireAccount(
  deps: BankToolDeps,
  userId: string,
  accountId?: string,
): Promise<Account> {
  const accounts = await deps.core.listAccounts(bankIds.user(userId))
  if (accountId !== undefined) {
    const found = accounts.find((account) => account.id === bankIds.account(accountId))
    if (found === undefined) {
      throw new BahError('account-forbidden', `bank-tools: 账户 ${accountId} 不属于当前用户`, {
        accountId,
      })
    }
    return found
  }
  const primary = accounts.find((account) => account.type === 'current') ?? accounts[0]
  if (primary === undefined) {
    throw new BahError('account-unknown', 'bank-tools: 当前用户名下没有可用账户', { userId })
  }
  return primary
}

/** 账号只展示尾号（核心层不脱敏，展示层负责）。 */
export function tailOf(number: string): string {
  const digits = number.replace(/\s+/g, '')
  return digits.slice(-4)
}
