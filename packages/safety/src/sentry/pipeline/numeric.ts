/**
 * 金额文本抽取。
 *
 * 只负责"把一段文本里的金额找出来"，不判断对错——对账在 `honesty.ts`。
 * 覆盖设计点名的三种形态：
 * 1. **千分位**：`¥12,345.67` / `1,234 元`；
 * 2. **万元表达**：`1.5 万元` / `5万`；
 * 3. **元角分**：`12 元 3 角 4 分` / `3 角 4 分` / `12 元 5 分`。
 *
 * 实现细节：按"先复合、后简单"的顺序消费，命中后把该段替换成等长空格——
 * 否则 `12 元 3 角 4 分` 会被同时抽成 1234、1200、34 三个数。全部换算成分（整数）比较，
 * 避免浮点误差。不依赖 locale 与 `Intl`（跨平台逐字一致， 的 `formatYuan` 同理）。
 */

/** 带千分位/小数的金额串（两位小数上限 = 分）。 */
const AMOUNT = String.raw`-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?`

/** 元 + 角 + 分（`12元3角4分` / `12元3角`）。 */
const YUAN_JIAO_FEN = /(\d+)\s*元\s*(\d+)\s*角(?:\s*(\d+)\s*分)?/g
/** 只有角 + 分（`3角4分`；通常跟在"12元"之后，已被上一条消费）。 */
const JIAO_FEN = /(\d+)\s*角\s*(\d+)\s*分/g
/** 元 + 分（`12元5分`）。 */
const YUAN_FEN = /(\d+)\s*元\s*(\d+)\s*分/g
/** 万元（`1.5万` / `5万元`）。 */
const WAN = new RegExp(String.raw`(${AMOUNT})\s*万(?:元|人民币)?`, 'g')
/** 货币符号前缀（`¥1,234.56` / `￥800`）。 */
const PREFIXED = new RegExp(String.raw`[¥￥]\s*(${AMOUNT})`, 'g')
/** 数字 + 货币单位（`1,234.56 元` / `800 块`）。 */
const SUFFIXED = new RegExp(String.raw`(${AMOUNT})\s*(?:元|人民币|块钱|块)`, 'g')

/**
 * 抽取文本中的全部金额（单位：分；去重升序）。
 *
 * @param text 任意文本（assistant 陈述 / 工具结果 / 参数备注）
 * @returns 金额（分）列表；空数组 = 没有可识别的金额
 */
export function extractAmountsCents(text: string): number[] {
  let rest = text
  const found: number[] = []

  rest = consume(rest, YUAN_JIAO_FEN, found, (match) => {
    const yuan = Number(match[1])
    const jiao = Number(match[2])
    const fen = match[3] === undefined ? 0 : Number(match[3])
    return yuan * 100 + jiao * 10 + fen
  })
  rest = consume(rest, JIAO_FEN, found, (match) => Number(match[1]) * 10 + Number(match[2]))
  rest = consume(rest, YUAN_FEN, found, (match) => Number(match[1]) * 100 + Number(match[2]))
  rest = consume(rest, WAN, found, (match) => Math.round(parseAmount(match[1]) * 10_000 * 100))
  rest = consume(rest, PREFIXED, found, (match) => Math.round(parseAmount(match[1]) * 100))
  consume(rest, SUFFIXED, found, (match) => Math.round(parseAmount(match[1]) * 100))

  return [...new Set(found.filter((value) => Number.isFinite(value)))].sort(
    (left, right) => left - right,
  )
}

/**
 * 单个"元"数值 → 分（工具参数里的 `amount` 字段）。
 *
 * @param value 元（数字或数字字符串）
 * @returns 分；无法解析时 `undefined`
 */
export function yuanToCents(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : undefined
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = parseAmount(value)
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined
  }
  return undefined
}

/**
 * 分 → `¥1,234.56`（与 `@bah/bank` 的 `formatYuan` 同形；不依赖 locale）。
 *
 * @param cents 金额（分）
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const yuan = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}¥${yuan}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * 把金额列表渲染成可读文本（校正文案用）。
 *
 * @param centsList 金额（分）
 * @param limit 最多列几个（其余以"等 N 项"收尾，避免文案过长）
 */
export function formatAmounts(centsList: readonly number[], limit = 3): string {
  const head = centsList.slice(0, limit).map(formatCents)
  const rest = centsList.length - head.length
  return rest > 0 ? `${head.join('、')} 等 ${centsList.length} 项` : head.join('、')
}

/** 消费一类模式：命中即收集并把原文换成等长空格（后续模式不再重复抽）。 */
function consume(
  text: string,
  pattern: RegExp,
  found: number[],
  convert: (match: RegExpExecArray) => number,
): string {
  let rest = text
  pattern.lastIndex = 0
  let match = pattern.exec(rest)
  while (match !== null) {
    found.push(convert(match))
    rest = `${rest.slice(0, match.index)}${' '.repeat(match[0].length)}${rest.slice(match.index + match[0].length)}`
    pattern.lastIndex = match.index + match[0].length
    match = pattern.exec(rest)
  }
  return rest
}

/** 金额串 → 浮点元（去千分位）。 */
function parseAmount(text: string | undefined): number {
  return Number((text ?? '').replaceAll(',', ''))
}
