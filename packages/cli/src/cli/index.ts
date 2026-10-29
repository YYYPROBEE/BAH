/**
 * @bah/cli · 逻辑模块 cli（施工单 06 §5 第 1 / 4 / 6 步的入口面）。
 *
 * 实现全在 `run.ts`（可单测）；`process` 相关的事只在 `../main.ts`。
 */
export { AUDIT_HELP, AUDIT_USAGE, runAudit } from './audit.ts'
export { parseCommand, type Command } from './command.ts'
export { COST_HELP, COST_USAGE, parseCostArgs, renderCostTable, runCost, summarize, type CostReport } from './cost.ts'
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
export { METRICS_HELP, METRICS_USAGE, parseMetricsArgs, runMetrics } from './metrics.ts'
export { PLAN_USAGE, parsePlanArgs, runPlan, type PlanCommand, type PlanCommonArgs } from './plan.ts'
export {
  OBS_DEFAULT_URL,
  getText,
  normalizeUrl,
  positiveInt,
  tokenOf,
  type HttpOutcome,
  type ObserveFetch,
} from './observe-http.ts'
export {
  SENTRY_HELP,
  SENTRY_USAGE,
  runSentryUnfreeze,
  type SentryIo,
  type SentryRunOptions,
} from './sentry.ts'
export { TRACE_HELP, TRACE_USAGE, parseTraceArgs, runTrace } from './trace.ts'
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
