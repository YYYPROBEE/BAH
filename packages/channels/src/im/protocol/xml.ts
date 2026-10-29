/**
 * 微信入站 XML 的安全解析（施工单 02 §2.6）。
 *
 * WHY 手写扫描而不是引 XML 库：
 * 1. 零依赖是硬约束（02 §1），而 Node 没有内置 XML 解析；
 * 2. 库的默认行为（展开实体、解析 DTD、处理命名空间）恰恰是我们**不允许**的——
 *    XXE / 实体膨胀 / billion laughs 都长在"通用解析器"的便利性里；
 * 3. 本单只需要读 `<xml>` 的**直接子标签**，格式由微信固定，扫描比建模更小、更可审。
 *
 * 六条硬约束（§2.6 原文，门禁 G3 钉住前两条）：
 * - 报文 ≤ 16 KiB；超限抛 `im-xml-too-large`；
 * - 出现 `<!DOCTYPE` / `<!ENTITY` / `<?xml-stylesheet` / `<script` → 抛 `im-xml-rejected`；
 * - 只读 `<xml>` 的直接子标签；未知标签忽略、**不递归展开**；
 * - 必填 `FromUserName` / `CreateTime`（10 位秒级）；`text` 还要 `Content`；
 * - CDATA 原样取值；无 CDATA 只解码五个命名实体，**不解析数字实体**；
 * - 不构造 DOM、不执行字符串求值。
 */

import { BahError } from '@bah/util'

/** 报文上限（字节）：微信文本消息远小于这个数，超限只可能是攻击或配置错。 */
export const WECHAT_XML_MAX_BYTES = 16 * 1024

/** 拒绝模式（大小写不敏感：XML 关键字不区分大小写，检测必须跟着不区分）。 */
const REJECTED_PATTERNS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /<!DOCTYPE/i, what: 'DOCTYPE' },
  { pattern: /<!ENTITY/i, what: 'ENTITY' },
  { pattern: /<\?xml-stylesheet/i, what: 'xml-stylesheet' },
  { pattern: /<script/i, what: 'script' },
]

/** 五个命名实体（**只**这五个；数字实体保持原样，避免实体膨胀的变体）。 */
const NAMED_ENTITY_PATTERN = /&(amp|lt|gt|quot|apos);/g
const ENTITY_CHARS: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** 解析结果。 */
export type WechatInbound =
  | {
      readonly kind: 'text'
      readonly toUser: string
      readonly fromUser: string
      readonly createTime: number
      readonly msgId?: string
      readonly content: string
    }
  | {
      readonly kind: 'event'
      readonly toUser: string
      readonly fromUser: string
      readonly createTime: number
      readonly event: string
      readonly eventKey?: string
    }
  | { readonly kind: 'unsupported'; readonly msgType: string }

/** 必填字段缺失 / 结构不合法。 */
function invalid(reason: string): BahError {
  return new BahError('im-xml-invalid', `im: 微信报文不合法（${reason}）`)
}

/**
 * 解析一条微信 XML 报文。
 *
 * @throws `BahError('im-xml-too-large')` 超过 16 KiB
 * @throws `BahError('im-xml-rejected')` 命中 DOCTYPE / ENTITY / stylesheet / script
 * @throws `BahError('im-xml-invalid')` 结构或必填字段不合法
 */
export function parseWechatXml(xml: string): WechatInbound {
  if (Buffer.byteLength(xml, 'utf8') > WECHAT_XML_MAX_BYTES) {
    throw new BahError(
      'im-xml-too-large',
      `im: 微信报文超过 ${String(WECHAT_XML_MAX_BYTES)} 字节（拒绝解析）`,
    )
  }
  for (const rule of REJECTED_PATTERNS) {
    if (rule.pattern.test(xml)) {
      throw new BahError('im-xml-rejected', `im: 微信报文含 ${rule.what}（拒绝解析）`)
    }
  }

  const fields = readChildren(xml)
  const msgType = required(fields, 'MsgType')
  const fromUser = required(fields, 'FromUserName')
  const createTime = readCreateTime(required(fields, 'CreateTime'))
  const toUser = fields.get('ToUserName') ?? ''

  if (msgType === 'text') {
    const content = fields.get('Content')
    if (content === undefined) throw invalid('text 消息缺少 Content')
    const msgId = fields.get('MsgId')
    return {
      kind: 'text',
      toUser,
      fromUser,
      createTime,
      ...(msgId === undefined ? {} : { msgId }),
      content,
    }
  }

  if (msgType === 'event') {
    const event = required(fields, 'Event')
    const eventKey = fields.get('EventKey')
    return {
      kind: 'event',
      toUser,
      fromUser,
      createTime,
      event,
      ...(eventKey === undefined ? {} : { eventKey }),
    }
  }

  return { kind: 'unsupported', msgType }
}

/** 取必填字段。 */
function required(fields: ReadonlyMap<string, string>, name: string): string {
  const value = fields.get(name)
  if (value === undefined || value.length === 0) throw invalid(`缺少 ${name}`)
  return value
}

/** `CreateTime` 必须是 10 位秒级整数。 */
function readCreateTime(raw: string): number {
  if (!/^\d{10}$/.test(raw)) throw invalid(`CreateTime 不是 10 位秒级整数（收到 ${raw.slice(0, 24)}）`)
  return Number(raw)
}

/**
 * 读出 `<xml>` 的直接子标签。
 *
 * 扫描规则：只认"`<Name ...>` + 中间值 + `</Name>`"与"`<Name .../>`"；
 * 值里再次出现 `<`（非 CDATA）说明是嵌套结构，直接判非法——**不递归**。
 */
function readChildren(xml: string): ReadonlyMap<string, string> {
  const rootStart = xml.indexOf('<xml')
  if (rootStart < 0) throw invalid('缺少 <xml> 根标签')
  const rootOpenEnd = findTagEnd(xml, rootStart)
  if (rootOpenEnd < 0) throw invalid('<xml> 开始标签未闭合')

  const rootClose = xml.lastIndexOf('</xml>')
  if (rootClose < rootOpenEnd) throw invalid('<xml> 结束标签缺失或顺序错')

  const inner = xml.slice(rootOpenEnd + 1, rootClose)
  const fields = new Map<string, string>()

  let index = 0
  while (index < inner.length) {
    while (index < inner.length && isWhitespace(inner[index] as string)) index += 1
    if (index >= inner.length) break
    if (inner[index] !== '<') throw invalid('子标签之间出现裸文本')

    const nameEnd = findNameEnd(inner, index + 1)
    if (nameEnd === index + 1) throw invalid('子标签缺少标签名')
    const name = inner.slice(index + 1, nameEnd)

    const tagEnd = findTagEnd(inner, index)
    if (tagEnd < 0) throw invalid(`子标签 <${name}> 未闭合`)
    if (/\/\s*$/.test(inner.slice(nameEnd, tagEnd))) {
      fields.set(name, '')
      index = tagEnd + 1
      continue
    }

    const closeTag = `</${name}>`
    const closeAt = inner.indexOf(closeTag, tagEnd + 1)
    if (closeAt < 0) throw invalid(`子标签 <${name}> 缺少结束标签`)

    fields.set(name, decodeValue(inner.slice(tagEnd + 1, closeAt), name))
    index = closeAt + closeTag.length
  }

  return fields
}

/** 空白（XML 里只把这四个字符当空白）。 */
function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

/** 标签名的合法字符（微信的字段名都是这个集合内的 ASCII）。 */
function isNameChar(char: string): boolean {
  return /[A-Za-z0-9_.-]/.test(char)
}

/** 标签名结束位置（属性开始或 `>` 前）。 */
function findNameEnd(text: string, from: number): number {
  let index = from
  while (index < text.length && isNameChar(text[index] as string)) index += 1
  return index
}

/** 找标签结束的 `>`（跳过引号内的 `>`；属性里的 `>` 不是标签结束）。 */
function findTagEnd(text: string, from: number): number {
  let quote: string | undefined
  for (let index = from; index < text.length; index += 1) {
    const char = text[index] as string
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return index
  }
  return -1
}

/**
 * 解一个标签的值。
 *
 * - 单个完整 CDATA 段：原样返回（这就是"CDATA 原样取值"）；
 * - 其余：若含 `<`（说明嵌套），判非法；否则只解码五个命名实体。
 */
function decodeValue(raw: string, name: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>')) {
    return trimmed.slice('<![CDATA['.length, -']]>'.length)
  }
  if (trimmed.includes('<')) throw invalid(`<${name}> 里出现嵌套标签（不递归解析）`)
  // 单次扫描替换：`&amp;lt;` 是用户输入的**字面文本** `&lt;`，不能二次解码成 `<`
  return trimmed.replace(NAMED_ENTITY_PATTERN, (match, name_: string) => ENTITY_CHARS[name_] ?? match)
}
