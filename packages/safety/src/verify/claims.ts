/**
 * 收益承诺类禁词的确定性检测（H-13 收口）。
 *
 * ## 为什么放在断言门，而不是一个过滤器
 *
 * 「保本保息」「零风险」在语义上就是**无法核验的断言**——不存在能证明它的证据。
 * 它本来就该归断言门管，而不是在输出链上再挂一个 `includes()` 黑名单。
 *
 * ## 为什么不能裸黑名单
 *
 * 裸关键词会误杀三类**必须说**的表述：
 * 1. 「本产品**不保本**」——否定窗口；
 * 2. 「您问的是**保本**吗？」——疑问语境（看匹配位置之后的问号）；
 * 3. 「监管**禁止**承诺保本保收益」——规范 / 引用语境。
 *
 * 规则是纯函数：不读时钟、不读环境、不访问 ctx；规则表是数组字面量，
 * 不是 YAML（它不是可调策略，是法定红线）。
 */

/** 禁词类别（稳定理由码之外的细分；审计与测试按它归类）。 */
export type ProhibitedClaimRule = 'principal' | 'return' | 'trend' | 'riskless'

/** 一条命中的禁词。 */
export interface ProhibitedClaim {
  readonly raw: string
  readonly start: number
  readonly end: number
  /** 命中所在分句（审计与调试用）。 */
  readonly sentence: string
  readonly rule: ProhibitedClaimRule
}

const RULES: readonly { readonly rule: ProhibitedClaimRule; readonly pattern: RegExp }[] = [
  { rule: 'principal', pattern: /保本(?:保息|保收益)?/g },
  { rule: 'return', pattern: /保证收益|保收益|收益保证|稳赚(?:不赔)?|包赚/g },
  { rule: 'trend', pattern: /必涨|只涨不跌|肯定涨/g },
  { rule: 'riskless', pattern: /零风险|无风险|绝对安全/g },
]

/** 否定窗口：命中前 8 字内出现否定词（`不承诺保本` 4 字、`并不代表产品保本` 8 字）。 */
const NEGATION = /(不|非|无|没有|并不|不承诺|不保证|不代表|不意味着|禁止|不得|严禁|不允许)[^，。；\n]{0,6}$/

/** 引用窗口：命中前 10 字内出现「您说 / 您问 / 所谓 / 指的是 / 是指」。 */
const QUOTE = /(您说|您问|所谓|指的是|是指)[^，。；\n]{0,10}$/

/** 分句边界（问号也在内：疑问判定靠边界字符，见 `isQuestion`）。 */
const CLAUSE_BREAK = '。！？!?；;\n，,'

/** 检测全部禁词命中（按位置排序；重叠命中只留先出现的一条）。 */
export function detectProhibitedClaims(text: string): readonly ProhibitedClaim[] {
  const found: ProhibitedClaim[] = []

  for (const { rule, pattern } of RULES) {
    // `g` 正则的 `lastIndex` 是跨调用状态：每次调用前必须归零，否则第二次从上次位置开始。
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (found.some((claim) => start < claim.end && end > claim.start)) continue

      const clause = clauseBoundsOf(text, start, end)
      if (isQuestion(text, end, clause.end)) continue
      if (NEGATION.test(text.slice(Math.max(clause.start, start - 8), start))) continue
      if (QUOTE.test(text.slice(Math.max(clause.start, start - 10), start))) continue

      found.push({
        raw: match[0],
        start,
        end,
        sentence: text.slice(clause.start, clause.end),
        rule,
      })
    }
  }

  return found.sort((left, right) => left.start - right.start)
}

interface ClauseBounds {
  readonly start: number
  readonly end: number
}

function clauseBoundsOf(text: string, start: number, end: number): ClauseBounds {
  let from = start
  while (from > 0 && !CLAUSE_BREAK.includes(text.charAt(from - 1))) from -= 1
  let to = end
  while (to < text.length && !CLAUSE_BREAK.includes(text.charAt(to))) to += 1
  return { start: from, end: to }
}

/**
 * 疑问语境：命中之后到分句结束仍是问句（`保本吗？` / `保本？`）。
 *
 * 只看 `text.slice(end, end + 1)` 会漏掉「保本**吗**？」——问号不是紧邻字符；
 * 分句又会在问号处切断，所以必须同时看分句尾的边界字符。
 */
function isQuestion(text: string, end: number, clauseEnd: number): boolean {
  if (/[？?]/.test(text.slice(end, clauseEnd))) return true
  const boundary = text.charAt(clauseEnd)
  return boundary === '？' || boundary === '?'
}
