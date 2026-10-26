/**
 * @bah/cli · 逻辑模块 cli（施工单 06 §5 第 1 / 4 / 6 步的入口面）。
 *
 * 实现全在 `run.ts`（可单测）；`process` 相关的事只在 `../main.ts`。
 */
export { AUDIT_HELP, AUDIT_USAGE, runAudit } from './audit.ts'
export { parseCommand, type Command } from './command.ts'
export {
  HALT_HELP,
  HALT_USAGE,
  UNFREEZE_USAGE,
  runHalt,
  runUnfreeze,
  type HaltFetch,
  type HaltIo,
  type HaltRunOptions,
} from './halt.ts'
export {
  SENTRY_HELP,
  SENTRY_USAGE,
  runSentryUnfreeze,
  type SentryIo,
  type SentryRunOptions,
} from './sentry.ts'
export {
  HELP,
  USAGE,
  describeReason,
  lastAssistantText,
  lastTurnEnd,
  parseArgs,
  runCli,
  type CliIo,
  type CliOptions,
  type ParseResult,
} from './run.ts'
