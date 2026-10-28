/**
 * 数字 / 单位 / 日期的归一化（W05 §1 第 3 条：防"换个写法就绕过核验"）。
 *
 * 三条纪律：
 * 1. **金额只用字符串 → 整数分**，全程不出现 `parseFloat` / `Number(x) * 100`
 *    （宪法 R-5；`decimalToInt` 用字符串移位 + 四舍五入到整数）；
 * 2. 中文数字（`八百` / `十万` / `一千二百`）与阿拉伯数字走同一条出口；
 * 3. 归一化失败返回 `undefined`，由调用方决定跳过——**绝不猜一个近似值**。
 */

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  贰: 2,
  两: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
}

const CN_SMALL_UNITS: Readonly<Record<string, number>> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
}

const CN_SECTION_UNITS: Readonly<Record<string, number>> = {
  万: 10_000,
  亿: 100_000_000,
}

/** 是否含中文数字字符（用于选择解析器）。 */
export function hasChineseDigit(text: string): boolean {
  return /[零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万亿点點]/.test(text)
}

/**
 * 中文数字 → decimal 字符串。
 *
 * 支持 `八百`、`十万`、`一千二百三十四`、`三点五`、`一亿零五万`；
 * **拒绝**口语省略（`一百五` / `三万五` / `一千二百三`）——它们的本意是 150 / 35000 / 1230，
 * 但字面解析会得到 105 / 30005 / 1203。猜错比不判更危险，所以返回 `undefined`。
 */
export function chineseToDecimal(text: string): string | undefined {
  if (text.length === 0) return undefined
  let total = 0
  let section = 0
  let digit = 0
  let seen = false
  let fraction = ''
  let inFraction = false
  /** 上一个 token 是量级单位（十/百/千/万/亿）。 */
  let previousWasUnit = false
  /** 最近一个量级单位的数值（用来判断省略写法是否歧义）。 */
  let lastUnitValue = 0
  /** 最后一个"紧跟单位出现"的数字（用于识别省略写法）。 */
  let directAfterUnit = false
  let directUnitValue = 0

  for (const char of text) {
    if (char === '点' || char === '點') {
      if (inFraction) return undefined
      inFraction = true
      previousWasUnit = false
      continue
    }
    if (inFraction) {
      const value = CN_DIGITS[char]
      if (value === undefined) return undefined
      fraction += String(value)
      seen = true
      continue
    }
    const digitValue = CN_DIGITS[char]
    if (digitValue !== undefined) {
      directAfterUnit = previousWasUnit && digitValue !== 0
      if (directAfterUnit) directUnitValue = lastUnitValue
      digit = digitValue
      previousWasUnit = false
      seen = true
      continue
    }
    const smallUnit = CN_SMALL_UNITS[char]
    if (smallUnit !== undefined) {
      if (digit === 0) digit = 1
      section += digit * smallUnit
      digit = 0
      previousWasUnit = true
      lastUnitValue = smallUnit
      directAfterUnit = false
      seen = true
      continue
    }
    const sectionUnit = CN_SECTION_UNITS[char]
    if (sectionUnit !== undefined) {
      total += (section + digit) * sectionUnit
      section = 0
      digit = 0
      previousWasUnit = true
      lastUnitValue = sectionUnit
      directAfterUnit = false
      seen = true
      continue
    }
    return undefined
  }
  if (!seen) return undefined
  // `一百五` / `三万五` / `一千二百三`：末位数字紧跟在 ≥100 的单位后且没有"零"——
  // 标准写法应带零（一百零五）或带后续单位（一百五十）。拒绝歧义写法。
  if (directAfterUnit && directUnitValue >= 100) return undefined
  const integer = total + section + digit
  return fraction.length === 0 ? String(integer) : `${String(integer)}.${fraction}`
}

/** 阿拉伯数字文本 → decimal 字符串（去千分位 / 货币符号 / 空白）。 */
export function parseDecimalText(text: string): string | undefined {
  const cleaned = text.replace(/[¥￥$,，\s]/g, '')
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return undefined
  return cleaned
}

/**
 * decimal 字符串 → `value * 10^scale` 的整数（half-up 到整数位）。
 *
 * 字符串运算，不经过浮点；超出安全整数范围返回 `undefined`。
 */
export function decimalToInt(value: string, scale: number): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return undefined
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) return undefined
  const [integerPart = '', fractionPart = ''] = value.split('.')
  const padded = fractionPart.padEnd(scale + 1, '0')
  const whole = `${integerPart}${padded.slice(0, scale)}`
  // 逐位累加：不经过 `Number(...)` / 浮点（宪法 R-5 的金额路径纪律）。
  let result = 0
  for (const char of whole) {
    const digit = char.charCodeAt(0) - 48
    if (digit < 0 || digit > 9) return undefined
    result = result * 10 + digit
  }
  if (padded.charCodeAt(scale) - 48 >= 5) result += 1
  return Number.isSafeInteger(result) ? result : undefined
}

/**
 * 金额文本 → 整数分。
 *
 * @param text 仅数字部分（不含 `元`/`块`/货币符号）
 * @param multiplier 数量级后缀（`万` = 10^4、`亿` = 10^8）
 */
export function moneyToCents(text: string, multiplier: '万' | '亿' | undefined = undefined): number | undefined {
  const raw = hasChineseDigit(text) ? chineseToDecimal(text) : parseDecimalText(text)
  if (raw === undefined) return undefined
  const extra = multiplier === '万' ? 4 : multiplier === '亿' ? 8 : 0
  return decimalToInt(raw, 2 + extra)
}

/**
 * 比率文本 → 基点（1 bp = 0.01%）。
 *
 * `0.3%` / `百分之零点三` → 30；`千分之三` → 30。
 */
export function rateToBasisPoints(
  text: string,
  unit: 'percent' | 'permille',
): number | undefined {
  const raw = hasChineseDigit(text) ? chineseToDecimal(text) : parseDecimalText(text)
  if (raw === undefined) return undefined
  return decimalToInt(raw, unit === 'percent' ? 2 : 1)
}

/**
 * 日期文本 → 规范串。
 *
 * - 带年份：`YYYY-MM-DD`；
 * - 不带年份：`MM-DD`（证据比对时按后缀匹配，允许回复省略年份）。
 */
export function canonicalDate(text: string): string | undefined {
  const trimmed = text.trim()
  const full = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(trimmed)
  if (full !== null) {
    const year = full[1] ?? ''
    const month = full[2] ?? ''
    const day = full[3] ?? ''
    return isDateParts(Number(month), Number(day)) ? `${year}-${pad2(month)}-${pad2(day)}` : undefined
  }
  const partial = /^(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/.exec(trimmed)
  if (partial !== null) {
    const month = partial[1] ?? ''
    const day = partial[2] ?? ''
    return isDateParts(Number(month), Number(day)) ? `${pad2(month)}-${pad2(day)}` : undefined
  }
  return undefined
}

/** 账号尾号 → 四位数字（不带尾号语义的裸数字不在此处理）。 */
export function normalizeTail(text: string): string | undefined {
  const digits = text.replace(/\D/g, '')
  return digits.length === 4 ? digits : undefined
}

function pad2(value: string): string {
  return value.padStart(2, '0')
}

function isDateParts(month: number, day: number): boolean {
  return Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31
}
