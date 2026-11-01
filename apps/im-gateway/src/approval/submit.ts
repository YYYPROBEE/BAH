/**
 * 审批 / 强验证 / 转人工的返回值 → 用户文案。
 *
 * 网关**不**自行判定过期或代填 `unavailable`：一切结论以子进程返回为准。
 * 这里只做"机器码 → 人话"与"HTTP 状态 → 人话"的翻译，不产生第二套结论语义。
 */

import type { ChildCallResult } from '../session/client.ts'
import { FAILED_TEXT } from '../config.ts'
import {
  ALREADY_DECIDED_TEXT,
  ALREADY_TAKEOVER_TEXT,
  APPROVED_TEXT,
  EXPIRED_TEXT,
  FOREIGN_TICKET_TEXT,
  INVALID_DECISION_TEXT,
  NO_CHALLENGE_TEXT,
  REASON_REQUIRED_TEXT,
  REJECTED_TEXT,
  TAKEOVER_TEXT,
  UNKNOWN_TICKET_TEXT,
  VERIFIED_TEXT,
  VERIFY_FAILED_TEXT,
} from './texts.ts'

/** 一次审批提交的翻译结果。 */
export interface SubmitText {
  readonly text: string
  readonly ok: boolean
  /** 子进程返回的错误码（只进日志，不进用户文案）。 */
  readonly code?: string
}

/** 从响应体里取结构化错误码（读不出来按空串）。 */
function errorCodeOf(result: ChildCallResult): string {
  if (result.status === 0) return 'network'
  const json = result.json
  if (typeof json !== 'object' || json === null) return ''
  const error = (json as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/** 代码 → 文案（未知码一律"处理失败"，不把内部码透给用户）。 */
function textOfCode(code: string): string {
  switch (code) {
    case 'unknown-ticket':
      return UNKNOWN_TICKET_TEXT
    case 'foreign-ticket':
      return FOREIGN_TICKET_TEXT
    case 'invalid-decision':
      return INVALID_DECISION_TEXT
    case 'reason-required':
      return REASON_REQUIRED_TEXT
    case 'already-decided':
      return ALREADY_DECIDED_TEXT
    case 'expired':
      return EXPIRED_TEXT
    case 'no-challenge':
      return NO_CHALLENGE_TEXT
    default:
      return FAILED_TEXT
  }
}

/**
 * 把 `POST /api/approval/:id` 的结果翻成用户文案。
 *
 * @param decision 本次提交的结论（成功时用来选"已批准 / 已拒绝"）
 */
export function mapDecideResult(
  result: ChildCallResult,
  decision: 'allowed-once' | 'rejected',
): SubmitText {
  if (result.status === 200) {
    return { text: decision === 'allowed-once' ? APPROVED_TEXT : REJECTED_TEXT, ok: true }
  }
  const code = errorCodeOf(result)
  return { text: textOfCode(code), ok: false, ...(code === '' ? {} : { code }) }
}

/** 把 `POST /api/verify/:id` 的结果翻成用户文案。 */
export function mapVerifyResult(result: ChildCallResult): SubmitText {
  if (result.status === 200) return { text: VERIFIED_TEXT, ok: true }
  const code = errorCodeOf(result)
  switch (code) {
    case 'unknown-ticket':
    case 'foreign-ticket':
    case 'no-challenge':
      return { text: textOfCode(code), ok: false, code }
    default:
      return { text: VERIFY_FAILED_TEXT, ok: false, ...(code === '' ? {} : { code }) }
  }
}

/** 把 `POST /api/handoff` 的结果翻成用户文案。 */
export function mapHandoffResult(result: ChildCallResult): SubmitText {
  if (result.status === 200) return { text: TAKEOVER_TEXT, ok: true }
  if (result.status === 409) return { text: ALREADY_TAKEOVER_TEXT, ok: false, code: 'already' }
  const code = errorCodeOf(result)
  return { text: FAILED_TEXT, ok: false, ...(code === '' ? {} : { code }) }
}
