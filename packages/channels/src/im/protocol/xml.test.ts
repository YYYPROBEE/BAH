import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { parseWechatXml, WECHAT_XML_MAX_BYTES, type WechatInbound } from './xml.ts'

/** 取结构化错误码（`toThrow(message)` 匹配不到 `code`）。 */
function codeOf(run: () => void): string {
  try {
    run()
    return 'no-throw'
  } catch (error) {
    return error instanceof BahError ? error.code : 'not-bah-error'
  }
}

/** 一段合法文本消息（CDATA 形态，与微信实际下发一致）。 */
const TEXT_XML = [
  '<xml>',
  '<ToUserName><![CDATA[gh_public]]></ToUserName>',
  '<FromUserName><![CDATA[o_user_1]]></FromUserName>',
  '<CreateTime>1793000000</CreateTime>',
  '<MsgType><![CDATA[text]]></MsgType>',
  '<Content><![CDATA[查余额]]></Content>',
  '<MsgId>1234567890</MsgId>',
  '</xml>',
].join('')

/** 造一份自定义内文的报文。 */
function xml(inner: string, attrs = ''): string {
  return `<xml${attrs}>${inner}</xml>`
}

/** 解一条必须成功的报文。 */
function parsed(input: string): WechatInbound {
  return parseWechatXml(input)
}

describe('parseWechatXml：合法报文（T-IM-009）', () => {
  it('CDATA 文本消息：字段逐个正确', () => {
    const inbound = parsed(TEXT_XML)
    expect(inbound).toEqual({
      kind: 'text',
      toUser: 'gh_public',
      fromUser: 'o_user_1',
      createTime: 1793000000,
      msgId: '1234567890',
      content: '查余额',
    })
  })

  it('无 CDATA 时只解码五个命名实体（不递归解码 `&amp;lt;`）', () => {
    const inbound = parsed(
      xml(
        '<ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
          '<MsgType>text</MsgType><Content>a&amp;b&lt;c&gt;d&quot;e&apos;f&amp;lt;</Content>',
      ),
    )
    expect(inbound.kind).toBe('text')
    if (inbound.kind !== 'text') return
    // `&amp;lt;` 是用户输入的**字面** `&lt;`，不是 `<`
    expect(inbound.content).toBe('a&b<c>d"e\'f&lt;')
  })

  it('数字实体不解析（实体膨胀的常见变体）', () => {
    const inbound = parsed(
      xml(
        '<ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
          '<MsgType>text</MsgType><Content>&#65;&#x41;</Content>',
      ),
    )
    expect(inbound.kind).toBe('text')
    if (inbound.kind !== 'text') return
    expect(inbound.content).toBe('&#65;&#x41;')
  })

  it('微信把 `]]>` 拆成两段 CDATA 时，解析还原原文（与 cdata() 对称）', () => {
    const inbound = parsed(
      xml(
        '<ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
          '<MsgType>text</MsgType><Content><![CDATA[a]]]]><![CDATA[>b]]></Content>',
      ),
    )
    expect(inbound.kind).toBe('text')
    if (inbound.kind !== 'text') return
    expect(inbound.content).toBe('a]]>b')
  })

  it('未知子标签忽略；自闭合标签取值空串；空白与缩进不影响解析', () => {
    const inbound = parsed(
      xml(
        '\n  <Extra/>\n  <ToUserName>gh</ToUserName>\n  <FromUserName>o</FromUserName>\n' +
          '  <CreateTime>1793000000</CreateTime>\n  <MsgType>text</MsgType>\n  <Content>hi</Content>\n',
      ),
    )
    expect(inbound.kind).toBe('text')
    if (inbound.kind !== 'text') return
    expect(inbound.content).toBe('hi')
  })

  it('根标签带属性，且属性值里出现 `>` 不提前截断', () => {
    const inbound = parsed(
      xml(
        '<ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
          '<MsgType>text</MsgType><Content>hi</Content>',
        ' a=">" b="x"',
      ),
    )
    expect(inbound.kind).toBe('text')
    if (inbound.kind !== 'text') return
    expect(inbound.content).toBe('hi')
  })

  it('文本消息没有 MsgId 时不编字段', () => {
    const inbound = parsed(
      xml(
        '<ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
          '<MsgType>text</MsgType><Content>hi</Content>',
      ),
    )
    expect(inbound).not.toHaveProperty('msgId')
  })

  it('事件消息（带 EventKey 与不带 EventKey）', () => {
    const click = parsed(
      xml(
        '<ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
          '<MsgType>event</MsgType><Event>CLICK</Event><EventKey>K</EventKey>',
      ),
    )
    expect(click).toEqual({
      kind: 'event',
      toUser: 'gh',
      fromUser: 'o',
      createTime: 1793000000,
      event: 'CLICK',
      eventKey: 'K',
    })
    const subscribe = parsed(
      xml(
        '<ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
          '<MsgType>event</MsgType><Event>subscribe</Event>',
      ),
    )
    expect(subscribe).not.toHaveProperty('eventKey')
  })

  it('非 text/event 的类型 → unsupported（网关回 success，不跑 turn）', () => {
    expect(
      parsed(
        xml(
          '<ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime>' +
            '<MsgType>image</MsgType>',
        ),
      ),
    ).toEqual({ kind: 'unsupported', msgType: 'image' })
  })
})

describe('parseWechatXml：拒绝路径（T-IM-009b）', () => {
  it('DOCTYPE → im-xml-rejected', () => {
    expect(codeOf(() => parseWechatXml('<!DOCTYPE xml><xml></xml>'))).toBe('im-xml-rejected')
  })

  it('ENTITY → im-xml-rejected', () => {
    expect(codeOf(() => parseWechatXml('<!ENTITY x "boom"><xml></xml>'))).toBe('im-xml-rejected')
  })

  it('xml-stylesheet → im-xml-rejected', () => {
    expect(codeOf(() => parseWechatXml('<?xml-stylesheet href="x"?><xml></xml>'))).toBe(
      'im-xml-rejected',
    )
  })

  it('script → im-xml-rejected（大小写不敏感）', () => {
    expect(codeOf(() => parseWechatXml('<XML><SCRIPT>alert(1)</script></XML>'))).toBe(
      'im-xml-rejected',
    )
  })

  it('超过 16 KiB → im-xml-too-large', () => {
    const big = 'x'.repeat(WECHAT_XML_MAX_BYTES)
    expect(codeOf(() => parseWechatXml(`<xml><Content>${big}</Content></xml>`))).toBe(
      'im-xml-too-large',
    )
  })

  it('缺 FromUserName / MsgType / Content → im-xml-invalid', () => {
    expect(
      codeOf(() =>
        parseWechatXml(
          xml('<MsgType>text</MsgType><Content>hi</Content><CreateTime>1793000000</CreateTime>'),
        ),
      ),
    ).toBe('im-xml-invalid')
    expect(codeOf(() => parseWechatXml(xml('<FromUserName>o</FromUserName>')))).toBe('im-xml-invalid')
    expect(
      codeOf(() =>
        parseWechatXml(
          xml('<FromUserName>o</FromUserName><CreateTime>1793000000</CreateTime><MsgType>text</MsgType>'),
        ),
      ),
    ).toBe('im-xml-invalid')
  })

  it('字段值为空串也算缺失（`<FromUserName/>` 与空标签）', () => {
    expect(
      codeOf(() =>
        parseWechatXml(
          xml(
            '<ToUserName>gh</ToUserName><FromUserName/><CreateTime>1793000000</CreateTime><MsgType>text</MsgType><Content>hi</Content>',
          ),
        ),
      ),
    ).toBe('im-xml-invalid')
    expect(
      codeOf(() =>
        parseWechatXml(
          xml(
            '<ToUserName>gh</ToUserName><FromUserName></FromUserName><CreateTime>1793000000</CreateTime><MsgType>text</MsgType><Content>hi</Content>',
          ),
        ),
      ),
    ).toBe('im-xml-invalid')
  })

  it('CreateTime 不是 10 位秒级整数 → im-xml-invalid', () => {
    expect(
      codeOf(() =>
        parseWechatXml(
          xml('<FromUserName>o</FromUserName><CreateTime>2026-01-01</CreateTime><MsgType>event</MsgType><Event>CLICK</Event>'),
        ),
      ),
    ).toBe('im-xml-invalid')
  })

  it('结构异常：缺根标签 / 根未闭合 / 结束标签顺序错', () => {
    expect(codeOf(() => parseWechatXml('<Foo></Foo>'))).toBe('im-xml-invalid')
    expect(codeOf(() => parseWechatXml('<xml'))).toBe('im-xml-invalid')
    expect(codeOf(() => parseWechatXml('<xml>abc'))).toBe('im-xml-invalid')
  })

  it('子标签之间出现裸文本 → im-xml-invalid', () => {
    expect(codeOf(() => parseWechatXml('<xml>abc<Foo>x</Foo></xml>'))).toBe('im-xml-invalid')
  })

  it('子标签缺少标签名 → im-xml-invalid', () => {
    expect(codeOf(() => parseWechatXml('<xml><>x</></xml>'))).toBe('im-xml-invalid')
  })

  it('子标签未闭合 / 缺结束标签 → im-xml-invalid', () => {
    expect(codeOf(() => parseWechatXml('<xml><Foo</xml>'))).toBe('im-xml-invalid')
    expect(codeOf(() => parseWechatXml('<xml><Foo>x</xml>'))).toBe('im-xml-invalid')
  })

  it('嵌套标签不递归展开，直接判非法', () => {
    expect(codeOf(() => parseWechatXml('<xml><Foo><Bar>x</Bar></Foo></xml>'))).toBe('im-xml-invalid')
  })

  it('错误信息不回显报文原文（只给字段名与截断后的 CreateTime）', () => {
    try {
      parseWechatXml(
        xml('<FromUserName>o</FromUserName><CreateTime>NOT_A_TIME</CreateTime><MsgType>event</MsgType><Event>CLICK</Event>'),
      )
    } catch (error) {
      expect((error as BahError).message).not.toContain('敏感原文')
      expect((error as BahError).message).toContain('CreateTime')
    }
  })
})

describe('边界：只解析直接子标签', () => {
  it('空内文（只有空白）解析成功但缺必填字段', () => {
    expect(codeOf(() => parseWechatXml('<xml>   </xml>'))).toBe('im-xml-invalid')
  })
})
