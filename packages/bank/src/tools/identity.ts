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
export type IdentityMethod = 'demo-config' | 'mock-login' | 'im-map' | 'session-auth'

/**
 * 会话身份（01 TA-13b）。
 *
 * `tenantId` 是**绑定发生时的租户**。它由宿主在 `bind` 时从 `RunContext.tenantId` 传下来，
 * 不写进 `identity/bound` 载荷——载荷多一个字段会让 7 份快照的字节全部变化，
 * 而那份数据在同一租户目录内是**同义反复**（会话日志只能被同租户进程读到）。
 * 真正的跨租户对账在审计链行上（`ChainRecord.tenant`），那里可被 `bah audit` 校验。
 */
export interface SessionIdentity {
  readonly userId: string
  readonly tenantId?: string
}

/** `identity/bound` 的载荷（与 `events.ts` 的声明逐字一致）。 */
export interface IdentityBoundData {
  readonly userId: string
  readonly method: IdentityMethod
  /** 绑定时刻（epoch ms）。 */
  readonly at: number
}

/** 会话身份存储（`BankIdentity` 的默认实现）。 */
export interface BankIdentityStore extends BankIdentity {
  /**
   * 绑定（重复绑定同一用户幂等；不同用户会覆盖，调用方负责审计）。
   *
   * @param tenantId 绑定时的租户（宿主传 `RunContext.tenantId`；不传 = 旧式调用）
   */
  bind(sessionId: SessionId, userId: string, tenantId?: string): void
  /** 兼容旧调用：只取用户 ID。 */
  resolve(sessionId: SessionId): string | undefined
  /** 取完整身份（用户 + 租户）；未绑定时 `undefined`。 */
  resolveIdentity(sessionId: SessionId): SessionIdentity | undefined
  /** 解除绑定（测试 / 登出用）。 */
  unbind(sessionId: SessionId): void
}

/** 服务键：09 的 credentials / 渠道登录拿到它来绑定。 */
export const BANK_IDENTITY: ServiceKey<BankIdentityStore> = defineService<BankIdentityStore>(
  'bank:identity',
)

/** 内存实现（会话 ID → 银行用户 + 租户）。 */
export class SessionIdentityStore implements BankIdentityStore {
  private readonly bindings = new Map<string, SessionIdentity>()

  bind(sessionId: SessionId, userId: string, tenantId?: string): void {
    const normalized = userId.trim()
    if (normalized.length === 0) {
      throw new BahError('identity-invalid', 'bank-identity: 用户 ID 不能为空', { sessionId })
    }
    this.bindings.set(
      sessionId,
      tenantId === undefined ? { userId: normalized } : { userId: normalized, tenantId },
    )
  }

  resolve(sessionId: SessionId): string | undefined {
    return this.bindings.get(sessionId)?.userId
  }

  resolveIdentity(sessionId: SessionId): SessionIdentity | undefined {
    const binding = this.bindings.get(sessionId)
    return binding === undefined ? undefined : { ...binding }
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
 *
 * **租户取自调用方**（当前进程的租户），不从载荷里读：
 * 会话日志在 `<root>/<tenant>/` 下，能读到它本身就已经证明它属于这个租户；
 * 载荷里再写一份只会是第二真相源（而且旧日志没有那个字段）。
 *
 * @param tenantId 当前租户（`RunContext.tenantId`）
 */
export function restoreSessionIdentity(
  store: BankIdentityStore,
  sessionId: SessionId,
  events: readonly { readonly type: string; readonly data: unknown }[],
  tenantId?: string,
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
  store.bind(sessionId, userId, tenantId)
}
