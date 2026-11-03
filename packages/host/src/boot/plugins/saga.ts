/**
 * base bundle · `bank:saga`：Saga 协调器接线（SA-07 §7.1 / SA-08 §3.5）。
 *
 * 注意：**不得**在 `inject` 里写 `bah:saga-clock`——时钟由本插件自己的 `provideSaga` 提供，
 * 自注入会让 `installAll` 永远等不到就绪而判死锁（core `inject-deadlock`）。
 *
 * 启动期恢复需要存储与审计同时就绪：用 `ctx.whenReady` 调度（不阻塞 apply，
 * 否则会与后装的审计插件互等）。
 */

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defineService, describeThrown } from '@bah/core'
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
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from '@bah/saga'

import type { Context } from '@bah/core'
import type { ChainRow } from '@bah/saga'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { recordAlertResult } from './alert-stats.ts'
import { logJson } from './log.ts'
import { SESSION_FILES } from './persistence.ts'

/** 供 SLO 桥读取**生效后**的 saga 阈值（02 / S2.6）；由 `bank:saga` 提供。 */
export const SAGA_SETTINGS = defineService<ReturnType<typeof parseSagaSettings>>('bah:saga-settings')

/**
 * 启动恢复失败的审计链 id（系统级事实，不属于任何单笔 saga）。
 *
 * 用独立链而不是塞进某笔 saga：混进别人的链会污染那条链的投影；
 * 不带 `:` —— 这个 id 会变成目录名（`<root>/system-startup/audit.jsonl`），
 * Windows 的 `:` 是 ADS 分隔符，进路径会直接失败。
 */
const RECOVERY_CHAIN_ID = 'system-startup'

/**
 * 把一次启动恢复失败 best-effort 落进审计链。
 *
 * 三个"为什么"：
 * - **best-effort**：审计不可写本身就是启动失败的常见原因（链还没就绪），
 *   记账失败绝不能再顶掉「恢复失败」这条事实，所以整段 try、失败只留 stderr；
 * - **不进签名白名单**：签名要读私钥，密钥缺失会让"记账"变成"第二次炸"；
 * - **不抛**：`.catch` 里再抛没人接（内核没有 start 钩子），等于把失败变成 unhandled rejection。
 */
function recordRecoveryFailure(ctx: Context, reason: string): void {
  try {
    ctx.get(SAGA_AUDIT).append(RECOVERY_CHAIN_ID, 'saga/recovery-failed', {
      reason,
      at: ctx.get(SAGA_CLOCK).now(),
    })
  } catch (auditError) {
    logJson('error', 'host.saga-recovery-audit-failed', { reason: describeThrown(auditError) })
  }
}

/** 链根跟随 persistence 的生效会话根（`--jsonl` 覆盖 / 配置 root 都同源）。 */
export const sagaPlugin: HostPlugin<ReturnType<typeof parseSagaSettings>> = {
  id: 'bank:saga',

  plugin: {
    name: 'bank:saga',
    inject: [SESSION_FILES.id],
    apply(ctx, settings) {
      ctx.provide(SAGA_SETTINGS, settings)
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
        //
        // D2：进程内汇**没有默认出口**——没人 `registerAlertSink` 时告警会静默消失。
        // 所以在这里固定补两路：① 结构化日志（stderr 单行 JSON，永远在）；
        // ② 可选文件出口（`BAH_ALERT_LOG` 指到路径才开，用于赛后/现场留证）。
        (level, message) => {
          const alertLevel = level === 'P0' ? 'P0' : 'alert'
          const sink = legacyAlertSink()
          sink(level, message)
          // `level` 是日志级别（固定字段），告警级别用 `alertLevel`，避免被字段覆盖成 P0/alert。
          logJson(level === 'P0' ? 'error' : 'warn', 'saga-alert', { alertLevel: level, message })
          recordAlertResult(alertLevel, 'stderr')
          const fileResult = appendAlertLine(process.env['BAH_ALERT_LOG'], level, message)
          if (fileResult === 'ok') recordAlertResult(alertLevel, 'file')
          if (fileResult === 'failed') recordAlertResult(alertLevel, 'failed')
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
          // 内核不提供 start 钩子；启动恢复失败必须可，不能静默吞错。
          const reason = describeThrown(error)
          // D2：改成单行 JSON（code 可枚举），不再是拼接串
          logJson('error', 'saga-recovery-failed', { reason })
          // B-6：stderr 不可审计、不可篡改检测。同一事实补一条链上记录。
          recordRecoveryFailure(ctx, reason)
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

/**
 * 可选的告警文件出口（D2）。
 *
 * 只在 `BAH_ALERT_LOG` 指向一个路径时启用：每次告警追加一行 JSON。
 * 用同步写：告警是稀疏事件（DLQ 升级/补偿失败），这里丢掉一行的代价比阻塞一次大。
 * **不建目录**——路径写错要立刻暴露，而不是悄悄写到别处。
 */
function appendAlertLine(
  file: string | undefined,
  level: string,
  message: string,
): 'none' | 'ok' | 'failed' {
  if (file === undefined || file.trim().length === 0) return 'none'
  try {
    appendFileSync(
      file,
      `${JSON.stringify({ ts: new Date().toISOString(), kind: 'saga-alert', level, message })}
`,
      'utf8',
    )
    return 'ok'
  } catch (error) {
    // 文件出口失败不能反过来打断业务；但必须可见
    logJson('warn', 'saga-alert-file-failed', { file, reason: describeThrown(error) })
    return 'failed'
  }
}
