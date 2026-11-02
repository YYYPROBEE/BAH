/**
 * 入口平面·归一化器（`normalize`）。
 * 对应源文件 `sentry-dsh-plugin/src/kernel/normalize.js`——正则、变换顺序、判定阈值一律照搬，
 * 不在移植面做"顺手优化"。
 *
 * 策略：只解码"无歧义的混淆载体"，不改写语义——归一化产物供检测器与审计消费，
 * 默认不回写用户消息本体（防止归一化破坏正常语义造成误报）。
 *
 * 内核零依赖纪律下的两处实现细节（外部行为与源一致）：
 * - base64 原语：源用 `Buffer`，这里换成同文件内的纯 TS 严格编解码，
 *   "重编码回原串才算合法载荷"的判据不变；
 * - 入参类型收紧为 `string`：源的 `String(text ?? '')` 是 JS 面的空值兜底，TS 由签名负责。
 */

/** 零宽字符（ZWSP/ZWNJ/ZWJ/BOM/软连字符）。 */
const ZERO_WIDTH = /[\u200b\u200c\u200d\ufeff\u00ad]/g

/** 常见 unicode 同形混淆映射（NFKC 覆盖不到的视觉同形兜底）。 */
const HOMOGLYPH_MAP: Readonly<Record<string, string>> = {
  '（': '(', '）': ')', '：': ':', '，': ',', '。': '.',
  '；': ';', '＜': '<', '＞': '>', '／': '/', '＼': '\\',
  '＂': '"', '＇': "'", '｜': '|', '？': '?', '！': '!', '＃': '#',
  '＠': '@', '＆': '&', '＝': '=', '＋': '+', '－': '-', '＊': '*',
  '％': '%', '＄': '$', '＾': '^', '～': '~', '｀': '`',
}

/** 拼音混淆特征 token（连续多音节拼音 + 原文极少汉字 → 可疑，仅标记不翻译）。 */
const PINYIN_TOKENS: ReadonlySet<string> = new Set([
  'hu', 'lue', 'yue', 'wang', 'ji', 'shou', 'quan', 'xian', 'zhi',
  'lve', 'mima', 'mimal', 'zhixing', 'mingling', 'shuru',
  'xiang', 'yaoshi', 'guanli', 'yonghu', 'qingshi', 'dayin', 'fuzhi',
  'fangwen', 'wangluo', 'duankai', 'chuanshu', 'waifa', 'xie',
  'wuxiao', 'hulue', 'zhiling', 'sha chu', 'linshi', 'quanxian',
])

/** 长 base64 候选块（≥24 字符，尾部 0–2 个填充符）。 */
const BASE64_BLOCK = /[A-Za-z0-9+/]{24,}={0,2}/g

/** 单空格混淆拆解点（"i g n o r e"）——只拆字母之间的单个空格。 */
const SPACED_LETTER = /(?<=[a-zA-Z]) (?=[a-zA-Z])/g

/** 拆解后才出现的攻击关键词（决定"间隔符混淆"这一步值不值得采用）。 */
const SPACE_JOIN_KEYWORDS = /\b(ignore|disregard|forget|bypass|system|prompt|instruction|previous)\b/i

/** base64 字母表（纯 TS 编解码用，顺序即 6 位无符号值）。 */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 归一化变换名（`pinyin_suspect` 携带命中 token，用模板字面量收窄）。
 */
export type NormalizeTransform =
  | 'zero_width_stripped'
  | 'nfkc_folded'
  | 'homoglyph_mapped'
  | 'base64_decoded'
  | 'space_join'
  | `pinyin_suspect:${string}`

/** `normalize()` 的结果：归一化文本 + 已应用的变换清单（供审计）。 */
export interface NormalizeResult {
  /** 归一化产物。 */
  readonly normalized: string
  /** 变换清单（顺序 = 应用顺序）。 */
  readonly transforms: NormalizeTransform[]
}

/**
 * 归一化入口。只做"可证伪的拆解"，不修改语义。
 *
 * @param text - 原始文本。
 * @returns 归一化文本与已应用的变换清单。
 */
export function normalize(text: string): NormalizeResult {
  const transforms: NormalizeTransform[] = []
  let out = text

  // 1) 零宽字符剥离
  const stripped = out.replace(ZERO_WIDTH, '')
  if (stripped !== out) {
    out = stripped
    transforms.push('zero_width_stripped')
  }

  // 2) 全角/同形字符折叠（NFKC 兼容分解）
  const folded = out.normalize('NFKC')
  if (folded !== out) {
    out = folded
    transforms.push('nfkc_folded')
  }

  // 3) 显式同形映射兜底（NFKC 不折叠的视觉同形由这一步收敛，例如「。」U+3002）
  const mapped = [...out].map((char) => HOMOGLYPH_MAP[char] ?? char).join('')
  if (mapped !== out) {
    out = mapped
    transforms.push('homoglyph_mapped')
  }

  // 4) base64 载荷探测（长 base64 块，严格编码校验后尝试解码为可读文本）
  let decodedAny = false
  out = out.replace(BASE64_BLOCK, (block) => {
    const decoded = tryDecodeBase64(block)
    if (decoded === null) return block
    decodedAny = true
    return ` ${decoded} `
  })
  if (decodedAny) transforms.push('base64_decoded')

  // 5) 间隔符混淆（"i g n o r e  p r e v i o u s"）：仅在拆解后出现攻击关键词时才采用
  const spaced = out.replace(SPACED_LETTER, '')
  if (spaced !== out && SPACE_JOIN_KEYWORDS.test(spaced)) {
    out = spaced
    transforms.push('space_join')
  }

  // 6) 拼音混淆标记（不翻译，只标记——降低误翻译误报）
  const tokens = new Set(out.toLowerCase().match(/[a-z]{2,10}/g) ?? [])
  const hits = [...tokens].filter((token) => PINYIN_TOKENS.has(token))
  if (hits.length > 0) {
    const cjkCount = (out.match(/[\u4e00-\u9fff]/g) ?? []).length
    if (cjkCount < out.length * 0.2) {
      transforms.push(`pinyin_suspect:${hits.sort().slice(0, 6).join(',')}`)
    }
  }

  return { normalized: out, transforms }
}

/**
 * 保守归一化：仅"零宽剥离 + NFKC 折叠"两步（不含任何语义改写），
 * 供可选的消息回写功能使用（配置 `detector.rewriteUserText`）。
 *
 * @param text - 原始文本。
 * @returns 保守归一化结果。
 */
export function conservativeNormalize(text: string): string {
  return text.replace(ZERO_WIDTH, '').normalize('NFKC')
}

/**
 * 严格 base64 解码：仅当重编码一致（无填充歧义）且解码出"可读中英文本"时返回结果。
 *
 * @param block - 候选 base64 块。
 * @returns 解码文本；不合法时返回 `null`（调用方原样保留该块）。
 */
function tryDecodeBase64(block: string): string | null {
  const bytes = decodeBase64Bytes(block)
  if (bytes === null) return null
  const reencoded = encodeBase64Bytes(bytes).replace(/=+$/, '')
  if (reencoded !== block.replace(/=+$/, '')) return null
  const decoded = new TextDecoder('utf-8').decode(bytes)
  const readable = /[\u4e00-\u9fff]/.test(decoded) || /[a-zA-Z]{4,}/.test(decoded)
  return decoded.length >= 8 && readable ? decoded : null
}

/**
 * base64 → 字节；长度或回编不合法时返回 `null`。
 *
 * 字符合法性由 `BASE64_BLOCK` 的模式保证（只可能含字母表字符与尾部填充），
 * 因此这里不再重复校验字符集——任何漏网的畸形块都会在"重编码比对"处露馅。
 */
function decodeBase64Bytes(block: string): Uint8Array | null {
  const pads = block.endsWith('==') ? 2 : block.endsWith('=') ? 1 : 0
  const body = block.slice(0, block.length - pads)
  if (body.length % 4 === 1) return null
  const bytes = new Uint8Array(Math.floor((body.length * 6) / 8))
  let cursor = 0
  let accumulator = 0
  let bits = 0
  for (const char of body) {
    accumulator = (accumulator << 6) | (BASE64_ALPHABET.indexOf(char) & 0x3f)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[cursor] = (accumulator >> bits) & 0xff
      cursor += 1
    }
  }
  return bytes
}

/** 字节 → 规范 base64（含尾部填充）。 */
function encodeBase64Bytes(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    // 循环界内首个字节必然存在，后两个按尾部零头补 0
    const chunk = (bytes[index] as number) << 16 | (bytes[index + 1] ?? 0) << 8 | (bytes[index + 2] ?? 0)
    const remaining = bytes.length - index
    out += BASE64_ALPHABET.charAt((chunk >> 18) & 0x3f)
    out += BASE64_ALPHABET.charAt((chunk >> 12) & 0x3f)
    out += remaining > 1 ? BASE64_ALPHABET.charAt((chunk >> 6) & 0x3f) : '='
    out += remaining > 2 ? BASE64_ALPHABET.charAt(chunk & 0x3f) : '='
  }
  return out
}
