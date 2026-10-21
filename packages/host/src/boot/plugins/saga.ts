/**
 * base bundle · `bank:saga`：Saga 协调器接线（SA-07 §7.1 / SA-08 §3.5）。
 *
 * 注意：**不得**在 `inject` 里写 `bah:saga-clock`——时钟由本插件自己的 `provideSaga` 提供，
 * 自注入会让 `installAll` 永远等不到就绪而判死锁（core `inject-deadlock`）。
 *
 * 启动期恢复需要存储与审计同时就绪：用 `ctx.whenReady` 调度（不阻塞 apply，
 * 否则会与后装的审计插件互等）。
 */

import { resolve } from 'node:path'

import { ChainFile, projectionDiff } from '@bah/persistence'
import type { ProjectionReducer } from '@bah/persistence'
import {
  installConvergence,
  legacyAlertSink,
  parseSagaSettings,
  provideSaga,
  recoverAll,
  reduceSaga,
} from '@bah/saga'
import { SAGA_AUDIT, SAGA_STORE } from '@bah/saga'

import type { ChainRow } from '@bah/saga'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { SESSION_FILES } from './persistence.ts'

/** 链根跟随 persistence 的生效会话根（`--jsonl` 覆盖 / 配置 root 都同源）。 */
export const sagaPlugin: HostPlugin<ReturnType<typeof parseSagaSettings>> = {
  id: 'bank:saga',

  plugin: {
    name: 'bank:saga',
    inject: [SESSION_FILES.id],
    apply(ctx, settings) {
      provideSaga(ctx, settings)
      const chainRoot = resolve(ctx.get(SESSION_FILES).root)
      const chain = new ChainFile({ rootDir: chainRoot, fsync: false })

      // ① 收敛注册**在 apply 内同步完成**：此刻 owner 还是 `bank:saga` 的桶，
      //    两个 tick 任务的 disposer 才会随插件卸载/替换一起回滚。
      //    它不需要 SAGA_STORE 就绪——登记的是回调，读库发生在回调被触发时
      //    （放进 `.then()` 会落到 kernel 桶：插件被替换后仍替系统关 Saga）。
      installConvergence(
        ctx,
        settings,
        () => undefined,
        async () => [],
        {
          projectionDiff: (sagaId) =>
            projectionDiff(ctx, chain, sagaId, reduceSaga as unknown as ProjectionReducer),
          readStream: (sagaId): readonly ChainRow[] =>
            chain.read(sagaId).map((row) => ({ q: row.q, t: row.t, sub: row.sub, hb: row.hb })),
        },
        // DLQ 升级等常规告警进进程内汇；邮件/webhook 由渠道适配器消费。
        (level, message) => {
          const sink = legacyAlertSink()
          sink(level, message)
        },
      )

      // ② 只有"启动恢复"必须等存储与审计就绪：调度仍不阻塞 apply（否则与后装的
      //    审计插件互等），但取消权交给 ctx.effect —— 插件卸载后那次 `.then` 不许再跑。
      //    disposer 同步执行，所以只置一个布尔量，不 await（异步清理要另行登记）。
      let cancelled = false
      void Promise.all([ctx.whenReady(SAGA_STORE), ctx.whenReady(SAGA_AUDIT)])
        .then(() => {
          if (cancelled) return
          recoverAll(ctx, settings)
        })
        .catch((error: unknown) => {
          // 内核不提供 start 钩子；启动恢复失败必须可见，不能静默吞错。
          console.error(
            `bah-saga: recovery-failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      ctx.effect(() => {
        cancelled = true
      })
    },
  },

  validate(config) {
    return parseSagaSettings(config)
  },
}
