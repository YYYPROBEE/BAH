/**
 * `fact:store`：生活事实库的宿主接线（G3）。
 *
 * 三件事：
 * 1. 装配期从会话事件 `replayFacts` 重建账本（重启后事实还在——这是"落账"的意义）；
 * 2. 注册三个内置工具（`fact_remember` / `fact_list` / `fact_forget`），不算银行工具目录；
 * 3. 提供 `bah:fact` 服务，供授权窗口取版本表（`fact-unchanged` 条件）。
 *
 * 零新事件键：落账只走 `tool/call` + `tool/result`。
 */

import { defineService } from '@bah/core'
import {
  SESSION_SERVICE,
  TOOLS_SERVICE,
  createFactTools,
  replayFacts,
  type FactStore,
} from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { askForNonBankTools } from './ask.ts'
import { readPositiveInteger, readBoolean, rejectUnknownKeys } from '../config.ts'

/** 服务键：`bah:fact`（只读账本视图 + 工具写入）。 */
export const FACT_SERVICE = defineService<FactStore>('bah:fact')

/** 宿主内部消费方（`plan:dag` 的窗口复验）按类型引用账本。 */
export type { FactStore }

/** `fact:store` 的配置。 */
export interface FactSettings {
  /** 总开关：关掉时不注册工具、不提供服务（等价于没装）。 */
  readonly enabled: boolean
  /**
   * `fact_forget` 审批票据的 TTL（毫秒）。
   *
   * 非银行工具没有 bank-core 五绑定票据，这个 TTL 只决定"等人应答多久"。
   */
  readonly approvalTtlMs: number
}

/** 缺省开启：事实库是纯内存 + 事件重建，没有外部副作用。 */
export const DEFAULT_FACT: FactSettings = { enabled: true, approvalTtlMs: 120_000 }

const WHERE = 'fact:store'

/** id 只用于展示与条件比对；从事件里已有 id 的最大序号续号，避免重放后撞号。 */
function maxFactSeq(store: FactStore): number {
  let max = 0
  for (const fact of store.list()) {
    const match = /^f-(\d+)$/.exec(fact.factId)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return max
}

export const factPlugin: HostPlugin<FactSettings> = {
  id: 'fact:store',

  plugin: {
    name: 'fact:store',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id],
    apply(ctx, settings) {
      if (!settings.enabled) return

      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)

      // 重放即在线账本：`nextId` 在写入时才求值，所以可以先拿到 store 再续号
      let store: FactStore
      store = replayFacts(session.events(), {
        nextId: () => `f-${String(maxFactSeq(store) + 1)}`,
      })

      // 当前回合（`ToolExecContext` 不带 turn，与 goal 平面同款做法）
      let currentTurn = 0
      for (const event of session.events()) {
        if (event.type === 'turn/start') currentTurn = Math.max(currentTurn, event.data.turn)
      }
      ctx.effect(
        ctx.events.on('session/event', ({ event }) => {
          if (event.type === 'turn/start') currentTurn = event.data.turn
        }),
      )

      const registry = ctx.get(TOOLS_SERVICE)
      for (const tool of createFactTools(store, { turnOf: () => currentTurn, now: run.now })) {
        ctx.effect(registry.register(tool))
      }
      // 删除类操作**必须**走审批：非银行工具的黄级默认是装饰品（governance 直接放行），
      // 只有这里自包一层 ask 才真的会签票据、等应答。
      askForNonBankTools(ctx, { names: ['fact_forget'], ttlMs: settings.approvalTtlMs })
      ctx.effect(ctx.provide(FACT_SERVICE, store))
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['enabled', 'approvalTtlMs'], WHERE)
    return {
      enabled: readBoolean(config, 'enabled', WHERE, DEFAULT_FACT.enabled),
      approvalTtlMs:
        readPositiveInteger(config, 'approvalTtlMs', WHERE) ?? DEFAULT_FACT.approvalTtlMs,
    }
  },
}
