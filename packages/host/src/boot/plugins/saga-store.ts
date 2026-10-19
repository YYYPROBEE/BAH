/**
 * base bundle · `bank:saga-store`：sqlite 状态底座（SA-07 §7.3）。
 *
 * 必须独立成插件：否则 `bah:saga-store` 无人提供，协调器 `ctx.get(SAGA_STORE)` 直接抛
 * `service-missing`。打开即迁移；dispose 时关闭连接。
 */

import { resolve } from 'node:path'

import { createSagaStore } from '@bah/persistence'
import { SAGA_STORE } from '@bah/saga'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { readString, rejectUnknownKeys } from '../config.ts'

/** `bank:saga-store` 的配置。 */
export interface SagaStoreSettings {
  /** sqlite 文件路径；相对进程 cwd；`:memory:` 仅用于测试。 */
  readonly dbPath: string
}

export const sagaStorePlugin: HostPlugin<SagaStoreSettings> = {
  id: 'bank:saga-store',

  plugin: {
    name: 'bank:saga-store',
    apply(ctx, config) {
      const dbPath = config.dbPath === ':memory:' ? ':memory:' : resolve(process.cwd(), config.dbPath)
      const store = createSagaStore({ dbPath })
      ctx.provide(SAGA_STORE, store)
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
