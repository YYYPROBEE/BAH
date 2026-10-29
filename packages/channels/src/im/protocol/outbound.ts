/**
 * 微信出站编码与字节分片（施工单 02 §2.7）。
 *
 * 两条容易写错的口径：
 * 1. **收发件人对调**：出站 `ToUserName` = 入站 `FromUserName`，出站 `FromUserName` =
 *    入站 `ToUserName`。写反了微信会丢弃报文，且**不会报错**——最难查的一类故障；
 * 2. **`]]>` 必须拆开**：CDATA 里出现 `]]>` 会提前闭合，后续文本变成 XML 结构，
 *    微信侧表现为"消息丢了半截"或"整条不展示"。
 *
 * 分片按**码点**而不是 UTF-16 单元切：`for...of` 遍历字符串天然按码点，
 * 不会把 emoji 的代理对劈成两半（劈开会生成孤立代理，JSON/日志里都是乱码）。
 */

/** 微信单条文本上限（字节；公众号客服消息与被动回复同口径）。 */
export const WECHAT_TEXT_MAX_BYTES = 2048

/** 把文本包成 CDATA，并把内嵌的 `]]>` 拆成合法的两段 CDATA。 */
export function cdata(text: string): string {
  return `<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`
}

/** 被动回复 XML 的入参。 */
export interface PassiveTextInput {
  readonly toUser: string
  readonly fromUser: string
  readonly content: string
  readonly nowSec: number
}

/**
 * 编码一条被动回复文本（全 CDATA）。
 *
 * `CreateTime` 用注入的 `nowSec`，不读 `Date.now()`：同一份出站必须可重放出同一份报文。
 */
export function encodePassiveText(input: PassiveTextInput): string {
  return [
    '<xml>',
    `<ToUserName>${cdata(input.toUser)}</ToUserName>`,
    `<FromUserName>${cdata(input.fromUser)}</FromUserName>`,
    `<CreateTime>${String(input.nowSec)}</CreateTime>`,
    `<MsgType>${cdata('text')}</MsgType>`,
    `<Content>${cdata(input.content)}</Content>`,
    '</xml>',
  ].join('')
}

/**
 * 按字节上限把文本切成若干片（`for...of` 按码点遍历，不切断代理对）。
 *
 * 空文本返回空数组（"空内容不发送"由调用方判，这里只做切分）。
 */
export function splitTextByBytes(text: string, maxBytes: number): readonly string[] {
  if (text.length === 0) return []
  if (maxBytes <= 0) return [text]

  const chunks: string[] = []
  let current = ''
  let currentBytes = 0

  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    // 单码点就超过上限（只可能是 maxBytes < 4 的畸形配置）：整段作为一片交给上层拒绝
    if (size > maxBytes) {
      if (current.length > 0) chunks.push(current)
      current = ''
      currentBytes = 0
      chunks.push(char)
      continue
    }
    if (currentBytes + size > maxBytes) {
      chunks.push(current)
      current = char
      currentBytes = size
      continue
    }
    current += char
    currentBytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 给多片文本加 `(i/n) ` 前缀，并保证加完后每片**仍**不超过 `maxBytes`。
 *
 * 为什么前缀要占预算：微信把整条消息按字节截断，`(1/3)` 被截在片尾等于用户看到乱码。
 * 预算按最坏情况估（`(999/999) ` = 10 字节），多切一片也比超限好。
 */
export function prefixChunks(chunks: readonly string[], maxBytes: number): readonly string[] {
  if (chunks.length <= 1) return chunks
  const reserve = 10
  const budget = maxBytes - reserve
  const limited: string[] = []
  for (const chunk of chunks) {
    const pieces = budget >= 4 && Buffer.byteLength(chunk, 'utf8') > budget ? splitTextByBytes(chunk, budget) : [chunk]
    for (const piece of pieces) limited.push(piece)
  }
  return limited.map((piece, index) => `(${String(index + 1)}/${String(limited.length)}) ${piece}`)
}
