/**
 * base bundle · `bank:saga`：Saga 协调器接线（SA-07 §7.1 / SA-08 §3.5）。
 *
 * 注意：**不得**在 `inject` 里写 `bah:saga-clock`——时钟由本插件自己的 `provideSaga` 提供，
 * 自注入会让 `installAll` 永远等不到就绪而判死锁（core `inject-deadlock`）。
 *
 * 启动期恢复需要存储与审计同时就绪：用 `ctx.whenReady` 调度（不阻塞 apply，
 * 否则会与后装的审计插件互等）。
 */

import { parseSagaSettings, provideSaga, recoverAll } from '@bah/saga'
import { SAGA_AUDIT, SAGA_STORE } from '@bah/saga'

import type { HostPlugin } from '../../plugin-manager/index.ts'

export const sagaPlugin: HostPlugin<ReturnType<typeof parseSagaSettings>> = {
  id: 'bank:saga',

  plugin: {
    name: 'bank:saga',
    apply(ctx, settings) {
      provideSaga(ctx, settings)

      void Promise.all([ctx.whenReady(SAGA_STORE), ctx.whenReady(SAGA_AUDIT)])
        .then(() => recoverAll(ctx, settings))
        .catch((error: unknown) => {
          // 内核不提供 start 钩子；启动恢复失败必须可见，不能静默吞错。
          console.error(
            `bah-saga: recovery-failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    },
  },

  validate(config) {
    return parseSagaSettings(config)
  },
}
