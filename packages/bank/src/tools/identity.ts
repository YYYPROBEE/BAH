/**
 * 会话身份绑定（施工单 09 §4 的 08 先行段）。
 *
 * 纪律：
 * - **绝不隐式使用默认账户**：没有绑定就是 `no-identity`，所有业务工具在前置判决处拒绝；
 * - 绑定是**会话级 durable 事实**：落 `identity/bound` 事件，回放/重启后从会话日志恢复；
 * - 09 的 credentials（mock 短信 / IM 映射 / Web 登录）只需调用 `BANK_IDENTITY.bind`，
 *   不需要改工具族。
 *
 * 本文件只做内存状态与恢复；事件落账由 host 插件负责（它持有 `SessionApi`）。
 */

import { defineService } from '@bah/core'
import type { ServiceKey, SessionId } from '@bah/core'
import { BahError } from '@bah/util'

import type { BankIdentity } from './types.ts'

/** 绑定方式（审计用；09 的 credentials 会追加更多来源）。 */
export type IdentityMethod = 'demo-config' | 'mock-login' | 'im-map'

/** `identity/bound` 的载荷（与 `events.ts` 的声明逐字一致）。 */
export interface IdentityBoundData {
  readonly userId: string
  readonly method: IdentityMethod
  /** 绑定时刻（epoch ms）。 */
  readonly at: number
}

/** 会话身份存储（`BankIdentity` 的默认实现）。 */
export interface BankIdentityStore extends BankIdentity {
  /** 绑定（重复绑定同一用户幂等；不同用户会覆盖，调用方负责审计）。 */
  bind(sessionId: SessionId, userId: string): void
  /** 解除绑定（测试 / 登出用）。 */
  unbind(sessionId: SessionId): void
}

/** 服务键：09 的 credentials / 渠道登录拿到它来绑定。 */
export const BANK_IDENTITY: ServiceKey<BankIdentityStore> = defineService<BankIdentityStore>(
  'bank:identity',
)

/** 内存实现（会话 ID → 银行用户 ID）。 */
export class SessionIdentityStore implements BankIdentityStore {
  private readonly bindings = new Map<string, string>()

  bind(sessionId: SessionId, userId: string): void {
    const normalized = userId.trim()
    if (normalized.length === 0) {
      throw new BahError('identity-invalid', 'bank-identity: 用户 ID 不能为空', { sessionId })
    }
    this.bindings.set(sessionId, normalized)
  }

  resolve(sessionId: SessionId): string | undefined {
    return this.bindings.get(sessionId)
  }

  unbind(sessionId: SessionId): void {
    this.bindings.delete(sessionId)
  }
}

/**
 * 按事件顺序恢复**指定会话**的绑定。
 *
 * `identity/bound` 的 envelope 已经归属某个会话；调用方只用本会话的事件调用本函数。
 * 后写的绑定覆盖先写的（与 `bind` 语义一致）。
 */
export function restoreSessionIdentity(
  store: BankIdentityStore,
  sessionId: SessionId,
  events: readonly { readonly type: string; readonly data: unknown }[],
): void {
  let userId: string | undefined
  for (const event of events) {
    if (event.type !== 'identity/bound') continue
    const data = event.data as Partial<IdentityBoundData>
    if (typeof data.userId === 'string' && data.userId.trim().length > 0) {
      userId = data.userId.trim()
    }
  }
  if (userId === undefined) return
  store.bind(sessionId, userId)
}
