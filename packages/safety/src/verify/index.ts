/**
 * 断言核验门（W05）：从助手回复抽取高影响断言，按本 turn 的工具证据做三态路由。
 *
 * 本模块是纯函数（无 ctx / 无时钟 / 无网络）；宿主的 `safety:verify` 插件负责
 * 监听 `agent/reply`、落 `safety/assertion` 事件。
 */

export {
  EVIDENCE_SUCCESS_MARKER,
  MONEY_ACTION_CLAIM,
  collectEvidence,
  extractAssertions,
} from './extract.ts'
export type { Assertion, AssertionKind, EvidenceSet } from './extract.ts'
export {
  canonicalDate,
  chineseToDecimal,
  decimalToInt,
  hasChineseDigit,
  moneyToCents,
  normalizeTail,
  parseDecimalText,
  rateToBasisPoints,
} from './normalize.ts'
export {
  ASSERTION_REJECT_CODE,
  UNVERIFIED_PREFIX,
  refusalText,
  verifyReply,
} from './route.ts'
export type { AssertionOutcome, VerifyOutcome, VerifyReplyInput } from './route.ts'
