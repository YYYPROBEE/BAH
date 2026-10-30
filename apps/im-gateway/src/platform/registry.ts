/**
 * 适配器注册表（施工单 02 §2.3）。
 *
 * WHY 表而不是 `if (platform === 'wechat')`：网关的路由是**通用**的
 * （`/im/:platform/:accountKey`），平台差异只在适配器内部。表一旦退化成 if 链，
 * "加第二个平台"就要改路由，那正是本单要避免的耦合（门禁 G10 的另一半）。
 *
 * 账号维度的处理（与 §2.3 的字面差异，已登记 `docs/im-gateway.md` §偏差）：
 * `PlatformAdapter` 契约里没有 `accountKey` 字段（契约是平台无关的），所以注册表
 * 额外接收一份 `accounts` 映射；缺省每个适配器只服务 `default`。
 */

import type { PlatformAdapter } from '@bah/channels'

/** 注册表条目：适配器 + 它服务的账号键。 */
export interface RegistryEntry {
  readonly adapter: PlatformAdapter
  readonly accounts: readonly string[]
}

/** 注册表对外接口。 */
export interface PlatformRegistry {
  /** 按平台 + 账号查适配器（未知 → `undefined`）。 */
  get(platform: string, accountKey: string): PlatformAdapter | undefined
  /** 已注册的平台与账号（`/healthz` 只给数量，不给账号；本方法供装配与测试用）。 */
  list(): readonly { readonly id: string; readonly accounts: readonly string[] }[]
  /** 平台数量（`/healthz.platforms`）。 */
  size(): number
}

/**
 * 造一个注册表。
 *
 * @param adapters 适配器清单；重复 id 是装配错误（fail-loud，不静默后者覆盖前者）
 * @param accounts 平台 → 账号清单；缺省每个平台只有 `default`
 */
export function createRegistry(
  adapters: readonly PlatformAdapter[],
  accounts: Readonly<Record<string, readonly string[]>> = {},
): PlatformRegistry {
  const table = new Map<string, RegistryEntry>()
  for (const adapter of adapters) {
    if (table.has(adapter.id)) {
      throw new Error(`im-gateway: 适配器 id 重复注册：${adapter.id}`)
    }
    const keys = accounts[adapter.id] ?? ['default']
    if (keys.length === 0) throw new Error(`im-gateway: ${adapter.id} 的账号清单不能为空`)
    table.set(adapter.id, { adapter, accounts: keys })
  }

  return {
    get(platform, accountKey) {
      const entry = table.get(platform)
      if (entry === undefined) return undefined
      if (!entry.accounts.includes(accountKey)) return undefined
      return entry.adapter
    },

    list() {
      return [...table.values()].map((entry) => ({
        id: entry.adapter.id,
        accounts: entry.accounts,
      }))
    },

    size() {
      return table.size
    },
  }
}
