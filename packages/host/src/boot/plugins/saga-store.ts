/**
 * base bundle · `bank:saga-store`：sqlite 状态底座（SA-07 §7.3）。
 *
 * 必须独立成插件：否则 `bah:saga-store` 无人提供，协调器 `ctx.get(SAGA_STORE)` 直接抛
 * `service-missing`。打开即迁移；dispose 时关闭连接。
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { createSagaStore } from '@bah/persistence'
import { SAGA_STORE, TARGET_REGISTRY } from '@bah/saga'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { readString, rejectUnknownKeys } from '../config.ts'
import { SESSION_FILES } from './persistence.ts'

/** `bank:saga-store` 的配置。 */
export interface SagaStoreSettings {
  /** sqlite 文件路径；相对**部署根**（不按租户分库，见下）；`:memory:` 仅用于测试。 */
  readonly dbPath: string
}

export const sagaStorePlugin: HostPlugin<SagaStoreSettings> = {
  id: 'bank:saga-store',

  plugin: {
    name: 'bank:saga-store',
    apply(ctx, config) {
      // 跟随部署根（不是租户根）：否则 --jsonl / per-run demo 只换了会话日志，
      // 事务库仍落在 sessions/，审计时会出现“库有事务、目录无链”的反向缺口。
      //
      // **01 §5 的裁剪决策**：saga 存储**不按租户分库**（单库单进程；`verify-saga-wiring`
      // 以固定路径 `sessions/saga.sqlite` 为基线）。要按租户分库，与 saga 单合并立项。
      // 除这里之外，任何地方都不许用 `baseRoot`——那会把租户面撕开一个口子。
      const dbPath =
        config.dbPath === ':memory:'
          ? ':memory:'
          : resolve(ctx.get(SESSION_FILES).baseRoot, config.dbPath)
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
      const store = createSagaStore({ dbPath })
      ctx.provide(SAGA_STORE, store)
      // SA-16 §8：批 6 补齐目标登记的生产提供者，避免补偿路径 `service-missing`。
      ctx.provide(TARGET_REGISTRY, {
        get: (targetSystem) => store.readTarget(targetSystem),
        list: () => store.listTargets(),
      })
      ctx.effect(() => {
        store.close()
      })
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['dbPath'], 'bank:saga-store')
    return { dbPath: readString(config, 'dbPath', 'bank:saga-store') ?? 'saga.sqlite' }
  },
}
