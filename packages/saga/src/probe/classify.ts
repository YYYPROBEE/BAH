/**
 * 错误分类白名单（SA-09 §3.3 / M5）。
 *
 * 白名单制：仅**明确**可重试的错误进重试；含糊码必须人工归类后才可加入。
 * 其余一切错误 → 补偿判定（SA-10），不在本模块扩权。
 */

/** 请求未发出 / 网关明确不可用 → 安全重试（同键）。 */
export const RETRYABLE: ReadonlySet<string> = new Set(['CONN_TIMEOUT', 'GATEWAY_503'])

const UNRESOLVED_EXACT: ReadonlySet<string> = new Set(['READ_TIMEOUT', 'STREAM_RESET'])

/** 失败分类结果。 */
export type FailureClass =
  | { readonly kind: 'retryable' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'compensate' }

/** 分类：可重试 → 重试；含糊（读超时/流断/AMBIGUOUS_*）→ 探诊；其余 → 补偿判定。 */
export function classify(code: string): FailureClass {
  if (RETRYABLE.has(code)) return { kind: 'retryable' }
  if (UNRESOLVED_EXACT.has(code) || code.startsWith('AMBIGUOUS_')) return { kind: 'unresolved' }
  return { kind: 'compensate' }
}

/**
 * `attempts ≥ maxAttempts` 强制 DLQ（代码级熔断，不可配置关闭——M5 / A23）。
 *
 * 纯函数，不受任何开关影响；`maxAttempts` 的合法性由 `parseSagaSettings` 载入期保证（≥ 1）。
 */
export function mustDeadLetter(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts
}
