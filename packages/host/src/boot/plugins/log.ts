/**
 * 结构化日志出口（D2 / 可观测性 02 S2.1）。
 *
 * 实现已迁到 `@bah/util` 的 `logging.ts`；本文件只做 **re-export**，保证
 * 既有 9 个调用点的 import 路径与签名一个字都不用改，也保证 `log.test.ts`
 * 仍然能 `vi.spyOn(console, 'error')` 接住唯一出口。
 *
 * 为什么必须搬走：`console.*` → `logJson` 的收口要覆盖 core/runtime/bank/persistence，
 * 那些包**不依赖 host**（依赖方向也不许反过来），只能依赖零依赖的 `@bah/util`。
 */

export {
  configureLogging,
  currentLogContext,
  logJson,
  logStats,
  loggingConfig,
  resetLogStats,
  runWithLogContext,
} from '@bah/util'

export type { LogContext, LogLevel, LogStats } from '@bah/util'
