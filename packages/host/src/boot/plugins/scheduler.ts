/**
 * `plan:scheduler`：到期唤醒的宿主驱动器（G2 / D1）。
 *
 * 两个触发点，**没有第二个定时器**：
 * 1. **boot 补跑**：插件 apply 末尾异步跑一次 `plan-wake`——"进程起来就补"，
 *    这是 06 卷 durable 承诺第一次成立的地方；
 * 2. **`saga/tick`**：复用既有 tick 派发点（与 janitor / recon / anchor 同一个时钟源）；
 *    间隔由 `bank:saga-bridge.tickIntervalMs` 决定，本插件不自建 interval。
 *
 * 失败只进日志与告警汇，不阻断后续 job（与 tick 的纪律一致）。
 */

import { registerTickJob } from '@bah/saga'
import { logJson } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { readBoolean, rejectUnknownKeys } from '../config.ts'
import { PLAN_WAKE_SERVICE, type PlanWakeReport, type PlanWakeRunner } from './plan.ts'

/** `plan:scheduler` 的配置。 */
export interface SchedulerSettings {
  /** 总开关：关掉即不注册 tick job、不做 boot 补跑。 */
  readonly enabled: boolean
  /** 启动时是否立即补跑一次（默认开）。关掉只剩 tick 驱动。 */
  readonly catchUpOnBoot: boolean
}

export const DEFAULT_SCHEDULER: SchedulerSettings = { enabled: true, catchUpOnBoot: true }

const WHERE = 'plan:scheduler'

export const schedulerPlugin: HostPlugin<SchedulerSettings> = {
  id: 'plan:scheduler',

  plugin: {
    name: 'plan:scheduler',
    // 只注入时钟：`bah:plan-wake` 在真正唤醒时才懒取（plan 插件允许缺席）
    inject: [RUN_SERVICE.id],
    apply(ctx, settings) {
      if (!settings.enabled) return

      const runWakeWith = (runner: PlanWakeRunner, source: 'boot' | 'tick'): void => {
        void runner
          .wake({ at: ctx.get(RUN_SERVICE).now(), source })
          .then((report: PlanWakeReport) => {
            if (!report.ok) {
              logJson('warn', 'host.plan-wake-refused', {
                source,
                code: report.code ?? 'unknown',
              })
              return
            }
            const executed = report.entries.filter((entry) => entry.status === 'executed').length
            if (executed > 0) {
              logJson('info', 'host.plan-wake', { source, executed, total: report.entries.length })
            }
          })
          .catch((error: unknown) => {
            logJson('error', 'host.plan-wake-failed', {
              source,
              reason: error instanceof Error ? error.message : String(error),
            })
          })
      }

      // tick job：与 janitor / recon / anchor 共用 `saga/tick` 这一个时钟源
      ctx.effect(
        registerTickJob('plan-wake', () => {
          try {
            runWakeWith(ctx.get(PLAN_WAKE_SERVICE), 'tick')
          } catch {
            // 没有 plan 插件时 tick 照常跳过（janitor / recon / anchor 不受影响）
          }
        }),
      )

      /**
       * boot 补跑：等 `bah:plan-wake` 就绪后再跑。
       *
       * 为什么不是"微任务里跑一次就完"：插件装配顺序由 profile 决定，本插件可能排在
       * `plan:dag` 之前；那时服务还没提供，一次性的微任务会把补跑静默吞掉
       * （"看起来会补跑，其实永远不会"）。所以用短间隔重试，最多 20 次（≈1s）。
       * 计时器是**一次性**的，不是第二个触发时钟——到期判定仍只由 `saga/tick` 与 CLI 提供。
       */
      const bootTimer: { handle?: ReturnType<typeof setTimeout> } = {}
      const catchUp = (attempt: number): void => {
        let runner
        try {
          runner = ctx.get(PLAN_WAKE_SERVICE)
        } catch {
          if (attempt < 20) {
            bootTimer.handle = setTimeout(() => catchUp(attempt + 1), 50)
            bootTimer.handle.unref?.()
          } else {
            logJson('warn', 'host.plan-catchup-unavailable', { attempts: attempt })
          }
          return
        }
        runWakeWith(runner, 'boot')
      }
      ctx.effect(() => {
        if (bootTimer.handle !== undefined) clearTimeout(bootTimer.handle)
      })
      if (settings.catchUpOnBoot) {
        queueMicrotask(() => catchUp(0))
      }
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['enabled', 'catchUpOnBoot'], WHERE)
    return {
      enabled: readBoolean(config, 'enabled', WHERE, DEFAULT_SCHEDULER.enabled),
      catchUpOnBoot: readBoolean(config, 'catchUpOnBoot', WHERE, DEFAULT_SCHEDULER.catchUpOnBoot),
    }
  },
}
