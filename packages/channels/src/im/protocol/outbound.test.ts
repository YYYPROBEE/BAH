import { describe, expect, it } from 'vitest'

import {
  cdata,
  encodePassiveText,
  prefixChunks,
  splitTextByBytes,
  WECHAT_TEXT_MAX_BYTES,
} from './outbound.ts'

/** 字符串的 UTF-8 字节数。 */
function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

describe('cdata', () => {
  it('普通文本包成 CDATA', () => {
    expect(cdata('hello')).toBe('<![CDATA[hello]]>')
  })

  it('内嵌 `]]>` 被拆成合法的两段 CDATA（T-IM-011）', () => {
    expect(cdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>')
  })
})

describe('encodePassiveText', () => {
  it('收发件人对调：ToUserName=用户、FromUserName=公众号', () => {
    const body = encodePassiveText({
      toUser: 'o_user',
      fromUser: 'gh_public',
      content: '收到',
      nowSec: 1793000000,
    })
    expect(body).toContain('<ToUserName><![CDATA[o_user]]></ToUserName>')
    expect(body).toContain('<FromUserName><![CDATA[gh_public]]></FromUserName>')
    expect(body).toContain('<CreateTime>1793000000</CreateTime>')
    expect(body).toContain('<MsgType><![CDATA[text]]></MsgType>')
    expect(body).toContain('<Content><![CDATA[收到]]></Content>')
    expect(body.startsWith('<xml>')).toBe(true)
    expect(body.endsWith('</xml>')).toBe(true)
  })

  it('CreateTime 来自注入值，不读当前时间（可重放）', () => {
    const body = encodePassiveText({ toUser: 'o', fromUser: 'gh', content: 'x', nowSec: 1 })
    expect(body).toContain('<CreateTime>1</CreateTime>')
    const later = encodePassiveText({ toUser: 'o', fromUser: 'gh', content: 'x', nowSec: 2 })
    expect(later).not.toBe(body)
  })
})

describe('splitTextByBytes（T-IM-011）', () => {
  it('空文本不产生片', () => {
    expect(splitTextByBytes('', WECHAT_TEXT_MAX_BYTES)).toEqual([])
  })

  it('maxBytes <= 0 时整段返回（畸形配置不静默丢内容）', () => {
    expect(splitTextByBytes('abc', 0)).toEqual(['abc'])
  })

  it('中文按字节切，每片不超过上限', () => {
    const text = '查'.repeat(1000) // 3 字节/字 = 3000 字节
    const chunks = splitTextByBytes(text, WECHAT_TEXT_MAX_BYTES)
    expect(chunks.length).toBe(2)
    for (const chunk of chunks) expect(bytes(chunk)).toBeLessThanOrEqual(WECHAT_TEXT_MAX_BYTES)
    expect(chunks.join('')).toBe(text)
  })

  it('不切断代理对（emoji 整颗进片）', () => {
    // 🙂 是 4 字节单一码点；maxBytes=5 时每片只能容纳一颗 emoji
    const chunks = splitTextByBytes('🙂🙂🙂', 5)
    expect(chunks).toEqual(['🙂', '🙂', '🙂'])
    for (const chunk of chunks) expect(chunk.length).toBe(2) // UTF-16 长度，说明代理对完整
  })

  it('单码点超过上限时单独成片（交给上层拒绝，不丢字符）', () => {
    expect(splitTextByBytes('a🙂b', 3)).toEqual(['a', '🙂', 'b'])
  })

  it('恰好等于上限时不再切', () => {
    expect(splitTextByBytes('abcd', 4)).toEqual(['abcd'])
  })
})

describe('prefixChunks', () => {
  it('单片不加前缀', () => {
    expect(prefixChunks(['abc'], 2048)).toEqual(['abc'])
  })

  it('多片加 (i/n) 前缀，且加完后仍不超过上限', () => {
    const text = '查'.repeat(1400) // 4200 字节
    const chunks = prefixChunks(splitTextByBytes(text, WECHAT_TEXT_MAX_BYTES), WECHAT_TEXT_MAX_BYTES)
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((chunk, index) => {
      expect(chunk.startsWith(`(${String(index + 1)}/${String(chunks.length)}) `)).toBe(true)
      expect(bytes(chunk)).toBeLessThanOrEqual(WECHAT_TEXT_MAX_BYTES)
    })
  })

  it('预留预算不足时不重切（小上限的畸形配置）', () => {
    expect(prefixChunks(['a', 'b'], 10)).toEqual(['(1/2) a', '(2/2) b'])
  })
})
