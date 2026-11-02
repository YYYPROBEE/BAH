/**
 * `@bah/bank` 适配层：把仿真银行的能力接到 `BankQuery` 端口上。
 *
 * **刻意的结构类型**：不 `import type` 银行包的 `BankCoreProvider`。memory 包一旦
 * import 银行包，就再也不能 headless 单测（要拖起整个 bank 域），而 §9 明确要求
 * 「memory 包不 import 任何底座包」。结构类型让"形状对得上就接得上"，也让将来换真实
 * 银行后端时不需要改这里。
 *
 * **必须如实说明的缺口**：`BankCoreProvider`（`packages/bank/src/core/provider.ts:180`）
 * 目前**没有卡状态查询**——只有 accounts / balance / transactions / bill / wealth /
 * limits。而记忆层最需要的恰恰是卡状态（`card_state` 是 STATEFUL 谓词，D1 的核心）。
 * 所以本适配器：
 *   - `kind:'account'` 用 `listAccounts` + `balance` 真查；
 *   - `kind:'card'` **必须由调用方注入 `cardStatus`**，未注入时返回 `null` 并上报
 *     `unsupported`——绝不伪造 `'normal'`。
 *
 * 这条边界是 M3 影子核验的地基：`null` 一旦被解释成"卡已注销"，D1 就变成了假证据。
 */

import type { BankQuery, EntityRef, EntityState } from '../types.ts'

/** 银行侧账户形状（只声明用得到的字段）。 */
export interface AccountLike {
  readonly id: string
  readonly status?: string
}

/** 仿真银行 provider 的最小结构面。 */
export interface ProviderLike {
  listAccounts(userId: string): Promise<readonly AccountLike[]>
  balance(accountId: string): Promise<{ readonly asOf: number }>
}

/** 卡状态查不到时用 `null`；与"接口未实现"必须由调用方区分（见文件头）。 */
export type CardStatusLookup = (tail4: string) => Promise<string | null>

export interface BankQueryAdapterOptions {
  readonly userId: string
  /** 未注入 → 对 `card` 返回 null 并上报 unsupported。 */
  readonly cardStatus?: CardStatusLookup
  /** `unsupported` 上报口（默认静默，生产接线时接日志/审计）。 */
  readonly onUnsupported?: (detail: { readonly kind: EntityRef['kind']; readonly key: string }) => void
  /** 时钟注入（`asOf` 用）。 */
  readonly now?: () => number
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

export function createBankQuery(
  provider: ProviderLike,
  options: BankQueryAdapterOptions,
): BankQuery {
  const now = options.now ?? Date.now

  return async (ref: EntityRef): Promise<EntityState | null> => {
    if (ref.kind === 'account') {
      const accounts = await provider.listAccounts(options.userId)
      const hit = accounts.find((account) => account.id === ref.key)
      if (hit === undefined) return null
      const snapshot = await provider.balance(ref.key)
      return { status: hit.status ?? 'normal', asOf: toIso(snapshot.asOf) }
    }

    if (ref.kind === 'card') {
      if (options.cardStatus === undefined) {
        // 银行 core 还没有卡查询接口：如实上报"不支持"，不猜。
        options.onUnsupported?.({ kind: ref.kind, key: ref.key })
        return null
      }
      const status = await options.cardStatus(ref.key)
      if (status === null) return null
      return { status, asOf: toIso(now()) }
    }

    // subscription：银行 core 同样没有订阅查询。返回 null，语义由调用方按 unsupported 处理。
    options.onUnsupported?.({ kind: ref.kind, key: ref.key })
    return null
  }
}
