/**
 * 高影响断言抽取（W05 §1）。
 *
 * 白名单写死五类：金额 / 余额 / 费率 / 日期 / 账号尾号。**不抽取**：
 * 流水号、票据号、电话号码、条款编号、普通计数——它们不是"钱/承诺"，
 * 抽进来只会制造误杀（演示现场最致命的失败模式）。
 *
 * 抽取是纯函数：不读时钟、不读环境、不访问 ctx。位置信息（start/end）用于
 * 去重与句子级路由；改写仍以整条回复为单位（见 route.ts）。
 */

import {
  canonicalDate,
  hasChineseDigit,
  moneyToCents,
  normalizeTail,
  rateToBasisPoints,
} from './normalize.ts'

/**
 * 断言类别（白名单）。
 *
 * `guarantee` 是第六类，不在 `extractAssertions` 的数字白名单里——它由
 * `claims.ts` 的禁词检测产出（保本 / 收益承诺 / 走势断言 / 零风险），
 * 定义上不可核验，`statusOf` 恒判 `rejected`。
 */
export type AssertionKind = 'amount' | 'balance' | 'rate' | 'date' | 'account-tail' | 'guarantee'

/** 一条被抽出的高影响断言。 */
export interface Assertion {
  readonly kind: AssertionKind
  /** 原文片段（审计与调试用；不参与判定）。 */
  readonly raw: string
  /** 规范值：金额/余额为整数分，费率为基点，日期为 ISO（可能无年），尾号为四位。 */
  readonly value: string
  readonly start: number
  readonly end: number
  /** 断言所在句子（用于"资金动作依据"判定）。 */
  readonly sentence: string
}

const CN_CLASS = '零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万亿点兩点'
const CN_SEQUENCE = `[${CN_CLASS}]+`
const NUMBER_SEQUENCE = String.raw`\d[\d,]*(?:\.\d+)?`
const ANY_NUMBER = `(?:${NUMBER_SEQUENCE}|${CN_SEQUENCE})`

/** `¥800` / `¥1.2万` / `¥八百`。 */
const SYMBOL_AMOUNT = new RegExp(
  String.raw`[¥￥]\s*(${ANY_NUMBER})\s*(万|亿)?`,
  'g',
)

/** `800 元` / `1.2万元` / `八百块` / `十万人民币`。 */
const UNIT_AMOUNT = new RegExp(
  String.raw`(${ANY_NUMBER})\s*(万|亿)?\s*(?:元|块|圆|人民币)`,
  'g',
)

/** `人民币 800`（无"元"字的口语 / 表格写法）。 */
const RMB_AMOUNT = new RegExp(
  String.raw`(?:人民币|RMB)\s*(${ANY_NUMBER})\s*(万|亿)?`,
  'gi',
)

/** `0.3%` / `百分之三` / `千分之三`。 */
const RATE = new RegExp(
  String.raw`(?:百分之|千分之)\s*(${ANY_NUMBER})|(${NUMBER_SEQUENCE})\s*[%％]`,
  'g',
)

/** `2026-10-26` / `2026年10月26日` / `10月26日`。 */
const DATE =
  /(?:(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?)|(?:(\d{1,2})\s*月\s*(\d{1,2})\s*日)/g

/** `尾号 1234` / `尾号为1234` / `****1234`。 */
const TAIL =
  /(?:尾号|账号尾号|卡号尾号)\s*(?:为|是|[:：])?\s*(\d{4})(?!\d)|\*{2,}\s*(\d{4})(?!\d)/g

/**
 * "资金动作已完成"的声明（决定 `reject` 还是 `needs-evidence`）。
 *
 * 只认明确的完成态：`已为你转出`、`转账成功`、`扣款完成`。`我建议你转 800 元`
 * 这类建议不在此列（没有资金动作，降级标注即可）。
 */
export const MONEY_ACTION_CLAIM =
  /(?:已|已经|刚刚|刚才)[^。！？!?\n]{0,16}(?:转出|转账|支付|扣款|购买|买入|赎回|缴费|汇款|充值)|(?:转出|转账|支付|扣款|购买|买入|赎回|缴费|汇款|充值)(?:成功|已完成|完成|到账)/

/** 工具出参里的"动作已发生"标记（只认这些出参作为资金动作的证据）。 */
export const EVIDENCE_SUCCESS_MARKER =
  /(转账成功|支付成功|扣款成功|购买成功|赎回成功|缴费成功|充值成功|受理成功|已转出|已支付|已扣款|已购买|已到账)/

/** 抽取结果。 */
export function extractAssertions(text: string): Assertion[] {
  const found: Assertion[] = []
  const sentences = sentenceSpansOf(text)

  const add = (
    kind: AssertionKind,
    value: string | undefined,
    start: number,
    end: number,
  ): void => {
    if (value === undefined || end <= start) return
    if (found.some((item) => start < item.end && end > item.start)) return
    const sentence = sentenceAt(sentences, start)
    const resolved: AssertionKind =
      kind === 'amount' || kind === 'balance'
        ? /(?:余额|结余|可用|存款)/.test(sentence)
          ? 'balance'
          : 'amount'
        : kind
    found.push({
      kind: resolved,
      raw: text.slice(start, end).trim(),
      value,
      start,
      end,
      sentence,
    })
  }

  for (const match of text.matchAll(RMB_AMOUNT)) {
    const start = match.index
    if (start === undefined) continue
    const cents = moneyOf(match[1], match[2])
    add('amount', cents === undefined ? undefined : String(cents), start, start + match[0].length)
  }
  for (const match of text.matchAll(SYMBOL_AMOUNT)) {
    const start = match.index
    if (start === undefined) continue
    const cents = moneyOf(match[1], match[2])
    add('amount', cents === undefined ? undefined : String(cents), start, start + match[0].length)
  }
  for (const match of text.matchAll(UNIT_AMOUNT)) {
    const start = match.index
    if (start === undefined) continue
    const cents = moneyOf(match[1], match[2])
    add('amount', cents === undefined ? undefined : String(cents), start, start + match[0].length)
  }
  for (const match of text.matchAll(RATE)) {
    const start = match.index
    if (start === undefined) continue
    const numeric = match[1] ?? match[2]
    const unit = match[1] === undefined ? 'percent' : match[0].startsWith('千分之') ? 'permille' : 'percent'
    const basisPoints = numeric === undefined ? undefined : rateToBasisPoints(numeric, unit)
    add(
      'rate',
      basisPoints === undefined ? undefined : String(basisPoints),
      start,
      start + match[0].length,
    )
  }
  for (const match of text.matchAll(DATE)) {
    const start = match.index
    if (start === undefined) continue
    const value = canonicalDate(match[0])
    add('date', value, start, start + match[0].length)
  }
  for (const match of text.matchAll(TAIL)) {
    const start = match.index
    if (start === undefined) continue
    const value = normalizeTail(match[1] ?? match[2] ?? '')
    add('account-tail', value, start, start + match[0].length)
  }

  return found.sort((left, right) => left.start - right.start)
}

/** 证据集合（从工具出参 / 权威库命中条目里抽出的规范值）。 */
export interface EvidenceSet {
  readonly values: ReadonlyMap<AssertionKind, ReadonlySet<string>>
  /** 带"动作成功"标记的金额（只有它能证明"已为你转出"）。 */
  readonly actionValues: ReadonlySet<string>
}

/** 从证据文本集合里抽值（本 turn 的工具出参 + 权威库命中条目）。 */
export function collectEvidence(texts: readonly string[]): EvidenceSet {
  const values = new Map<AssertionKind, Set<string>>()
  const actionValues = new Set<string>()

  for (const text of texts) {
    for (const assertion of extractAssertions(text)) {
      const bucket = values.get(assertion.kind) ?? new Set<string>()
      bucket.add(assertion.value)
      values.set(assertion.kind, bucket)
      if (
        (assertion.kind === 'amount' || assertion.kind === 'balance') &&
        EVIDENCE_SUCCESS_MARKER.test(assertion.sentence)
      ) {
        actionValues.add(assertion.value)
      }
    }
  }

  return { values, actionValues }
}

/** 句子 span（不含分隔符）。 */
interface SentenceSpan {
  readonly start: number
  readonly end: number
  readonly text: string
}

function sentenceSpansOf(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (!'。！？!?；;\n'.includes(text.charAt(index))) continue
    if (index > start) spans.push({ start, end: index, text: text.slice(start, index) })
    start = index + 1
  }
  if (start < text.length) spans.push({ start, end: text.length, text: text.slice(start) })
  if (spans.length === 0) spans.push({ start: 0, end: text.length, text })
  return spans
}

function sentenceAt(spans: readonly SentenceSpan[], position: number): string {
  for (const span of spans) {
    if (position >= span.start && position < span.end) return span.text
  }
  return spans.at(-1)?.text ?? ''
}

/** 金额匹配组 → 整数分。 */
function moneyOf(value: string | undefined, multiplier: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const scale = multiplier === '万' || multiplier === '亿' ? multiplier : undefined
  if (!hasChineseDigit(value) && !/^\d[\d,]*(?:\.\d+)?$/.test(value)) return undefined
  return moneyToCents(value, scale)
}
