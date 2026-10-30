/**
 * 商户名归一化（场景 5 §6.1）。
 *
 * 只做一件事：把同一条扣款渠道里长得不一样的商户名归到同一个稳定键。
 * `merchantKey` 是 `Subscription` / `MerchantAuthorization` / `RecurringSeries`
 * 三处关联的**唯一键**；`merchant` 只用于展示。
 *
 * 纪律：
 * - 纯函数、无时钟、无 IO；
 * - 幂等：`normalize(normalize(x)) === normalize(x)`；
 * - 稳定：大小写无关、全角半角无关、渠道前缀与门店噪声无关。
 */

/** 渠道前缀（小写；全角已转半角后匹配）。长的放前面，避免 `stm` 先吃掉 `stm*`。 */
const CHANNEL_PREFIXES: readonly string[] = [
  'stm*',
  'stm-',
  'stm',
  '支付宝-',
  '财付通-',
  '微信支付-',
  '快捷支付-',
  '银联-',
  '(特约)',
  '特约',
]

/**
 * 别名表：归一化中间结果 → canonical。
 *
 * 只登记**确认同义**的名字；不确定的宁可不合并（错合并会把两家扣款算成一家）。
 */
const MERCHANT_ALIASES: Readonly<Record<string, string>> = {
  video: '视频会员',
  腾讯视频: '视频会员',
  爱奇艺: '视频会员',
  优酷: '视频会员',
  网易云音乐: '云音乐',
  网易云: '云音乐',
  云音乐会员: '云音乐',
  music: '云音乐',
}

/** 全角 ASCII（U+FF01–U+FF5E）转半角。 */
function toHalfWidth(input: string): string {
  let output = ''
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x3000) {
      output += ' '
    } else if (code >= 0xff01 && code <= 0xff5e) {
      output += String.fromCodePoint(code - 0xfee0)
    } else {
      output += char
    }
  }
  return output
}

/** 反复剥离渠道前缀（脏数据可能叠两层，如「支付宝-特约-…」）。 */
function stripPrefixes(input: string): string {
  let current = input
  let changed = true
  while (changed) {
    changed = false
    for (const prefix of CHANNEL_PREFIXES) {
      if (current.startsWith(prefix)) {
        current = current.slice(prefix.length)
        changed = true
        break
      }
    }
  }
  return current
}

/**
 * 商户名 → 稳定键。
 *
 * 步骤：全角转半角 → 小写 → 剥离渠道前缀 → 去括号内容 → 去 `#门店号`/`*尾号`/连续数字
 * → 去空格标点 → 命中别名表则归一。
 */
export function normalizeMerchant(raw: string): string {
  // 先把空白去掉：`支付宝 - 云音乐` 与 `支付宝-云音乐` 必须归到同一个键
  const lowered = toHalfWidth(raw).toLowerCase().replace(/\s+/g, '')
  if (lowered.length === 0) return ''

  let current = stripPrefixes(lowered)
  // 括号内容（门店名）先去掉；未闭合的括号连内容一起丢
  current = current.replace(/\([^)]*\)/g, '')
  current = current.replace(/\(.*$/g, '')
  // `#123`、`*1234` 与连续数字（卡号尾号、门店编号）
  current = current.replace(/[#*]\d+/g, '')
  current = current.replace(/\d+/g, '')
  // 只保留中英文（去掉空格、标点、符号）
  current = current.replace(/[^\p{Script=Han}a-z]/gu, '')

  const canonical = MERCHANT_ALIASES[current]
  if (canonical !== undefined) return canonical
  // 归一化后什么都不剩时退回原始小写（保持可区分，不把所有噪声并成一个键）
  return current.length > 0 ? current : lowered
}
