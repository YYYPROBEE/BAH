/**
 * 阈值标识符名册（`verify-no-hardcoded-config` 的扫描面，门禁扩容 07 §2-7）。
 *
 * 为什么单独成册：阈值是可调项，随部署变化。名册写死在门禁里，新增阈值就要改门禁代码；
 * 抽成数据面后，新增一个阈值只需在这里加一行，规则本身不变。
 *
 * 口径来源（不是拍脑袋）：`packages/safety/src/sentry/pipeline/config.ts` 的
 * `SENTRY_CONFIG_KEYS` 数值字段、`packages/safety/src/sandbox-policy/tier.ts` 的
 * `TierLimits`，以及 `@bah/bank` 的两个资金阈值（与 `verify-tiers` 第 4 条同源）。
 */

/** 精确名册：字段名语义明确，命中即查。 */
export const THRESHOLD_NAMES: readonly string[] = [
  // safety · sentry 检测 / 熔断 / 降级 / 预算 / 循环 guard / trace
  'warnThreshold',
  'highThreshold',
  'denyThreshold',
  'invalidArgsThreshold',
  'flushThreshold',
  'totalCalls',
  'riskyCalls',
  'amountYuan',
  'maxToolsPerTurn',
  'ringSize',
  'windowSeconds',
  // safety · sandbox 档位限制
  'timeoutMs',
  'maxOperations',
  'maxOldGenMb',
  'maxPayloadBytes',
  // bank · 资金阈值（与 verify-tiers 第 4 条一致）
  'dailyTransferLimit',
  'riskyCallThreshold',
]

/**
 * 模式名册：给"同族但会继续加字段"的命名留位。
 *
 * 只认后缀，不认子串——`BANK_TOOL_LIMIT`（工具数量上限）这类非资金阈值不该被拦，
 * 所以 `limit` 必须作为独立词尾出现。
 */
export const THRESHOLD_PATTERNS: readonly RegExp[] = [
  /(threshold|quota)$/i,
  /(daily|transfer|risky)(limit|cap)$/i,
  /^max[A-Z]\w*(operations|bytes|calls|tools|moves)$/i,
]

/** 是否是阈值标识符。 */
export function isThresholdName(name: string): boolean {
  if (THRESHOLD_NAMES.includes(name)) return true
  return THRESHOLD_PATTERNS.some((pattern) => pattern.test(name))
}
