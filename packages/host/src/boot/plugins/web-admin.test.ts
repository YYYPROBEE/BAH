/**
 * 管理路由的纯函数（HP0-07 + body 边界）。
 *
 * 路由层测"状态码顺序"，这里测"判定本身"——尤其是回环判定：
 * 它是**唯一**把管理面关在本机的那道锁，写宽一点（比如接受 `0.0.0.0`）
 * 就等于把解冻口暴露到局域网。
 */

import { describe, expect, it } from 'vitest'

import {
  ADMIN_TOKEN_ENV,
  DEFAULT_UNFREEZE_REASON,
  isLoopbackAddress,
  parseHaltBody,
  parseUnfreezeBody,
  parseUnfreezeTicketBody,
  readAdminToken,
  tokenMatches,
} from './web-admin.ts'

describe('HP0-05 管理 token 只从环境变量读', () => {
  it('未设置 / 空白 → undefined（路由据此 404）', () => {
    expect(readAdminToken({})).toBeUndefined()
    expect(readAdminToken({ [ADMIN_TOKEN_ENV]: '' })).toBeUndefined()
    expect(readAdminToken({ [ADMIN_TOKEN_ENV]: '   ' })).toBeUndefined()
  })

  it('有值则去空白后返回', () => {
    expect(readAdminToken({ [ADMIN_TOKEN_ENV]: '  abc  ' })).toBe('abc')
  })
})

describe('HP0-07 回环判定', () => {
  it('回环地址全部接受', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(address), address).toBe(true)
    }
  })

  it('非回环一律拒绝（含"监听全部"的写法）', () => {
    for (const address of [
      '10.0.0.1',
      '192.168.1.10',
      '0.0.0.0',
      '::',
      '::ffff:10.0.0.1',
      '127.0.0.999',
      '127.0.0',
      'localhost',
      '',
      undefined,
    ]) {
      expect(isLoopbackAddress(address), String(address)).toBe(false)
    }
  })
})

describe('HP0-06 token 比较', () => {
  it('正确 Bearer → true（大小写不敏感的前缀）', () => {
    expect(tokenMatches('abc', 'Bearer abc')).toBe(true)
    expect(tokenMatches('abc', 'bearer abc')).toBe(true)
  })

  it('缺失 / 错 scheme / 空值 / 长度不同 → false（不抛错）', () => {
    expect(tokenMatches('abc', undefined)).toBe(false)
    expect(tokenMatches('abc', 'abc')).toBe(false)
    expect(tokenMatches('abc', 'Bearer ')).toBe(false)
    expect(tokenMatches('abc', 'Bearer abcd')).toBe(false)
    expect(tokenMatches('abc', 'Basic abc')).toBe(false)
  })
})

describe('HP0-10 解冻体解析', () => {
  it('by 必填、reason 可省（缺省 operator-unfreeze）', () => {
    expect(parseUnfreezeBody({ by: 'ops-7' })).toEqual({
      ok: true,
      by: 'ops-7',
      reason: DEFAULT_UNFREEZE_REASON,
    })
  })

  it('非对象 / 缺 by / 空 by → 400 语义', () => {
    for (const body of [null, [], 'x', {}, { by: '' }, { by: '   ' }, { by: 7 }]) {
      const parsed = parseUnfreezeBody(body)
      expect(parsed.ok, JSON.stringify(body)).toBe(false)
    }
  })

  it('未知键拒绝（管理面不接受多余字段）', () => {
    const parsed = parseUnfreezeBody({ by: 'ops-7', nope: 1 })
    expect(parsed).toMatchObject({ ok: false, code: 'web-admin-invalid-body' })
  })

  it('超长 by / reason 拒绝', () => {
    expect(parseUnfreezeBody({ by: 'x'.repeat(65) }).ok).toBe(false)
    expect(parseUnfreezeBody({ by: 'ops', reason: 'x'.repeat(201) }).ok).toBe(false)
  })

  it('reason 存在但非字符串 → 类型专属文案（与"超长"是两种错，审计与 CLI 文案都靠 code+detail 区分）', () => {
    // 为什么要逐形态钉：`reason: null` / 对象 / 数组 / 数字都会被 `!== undefined`
    // 放行到类型检查这一步；若这里退化成缺省值或超长文案，管理面就把"客户端写错"
    // 与"内容过长"混成同一条信息，排障时无从判断该改哪边。
    for (const reason of [42, true, null, {}, ['K1'], () => 'x']) {
      expect(parseUnfreezeBody({ by: 'ops-7', reason })).toEqual({
        ok: false,
        code: 'web-admin-invalid-body',
        detail: 'reason 必须是字符串',
      })
    }
  })
})

describe('W07 HALT 管理体解析', () => {
  it('halt：空对象 / 只有 detail 通过；空 detail 视为无 detail', () => {
    expect(parseHaltBody({})).toEqual({ ok: true })
    expect(parseHaltBody({ detail: '值班停机' })).toEqual({ ok: true, detail: '值班停机' })
    expect(parseHaltBody({ detail: '   ' })).toEqual({ ok: true })
    expect(parseHaltBody({ detail: '  x  ' })).toEqual({ ok: true, detail: 'x' })
  })

  it('halt：非对象 / 未知键 / detail 类型错 / 超长 全部拒绝', () => {
    for (const body of [null, [], 'x', { reason: 'manual' }, { force: true }]) {
      expect(parseHaltBody(body).ok, JSON.stringify(body)).toBe(false)
    }
    expect(parseHaltBody({ detail: 42 })).toEqual({
      ok: false,
      code: 'web-admin-invalid-body',
      detail: 'detail 必须是字符串',
    })
    expect(parseHaltBody({ detail: 'x'.repeat(201) }).ok).toBe(false)
  })

  it('unfreeze：ticketId 必填 / 字符集受限 / 没有 force 字段', () => {
    expect(parseUnfreezeTicketBody({ ticketId: 't-1' })).toEqual({ ok: true, ticketId: 't-1' })
    expect(parseUnfreezeTicketBody({ ticketId: ' ticket:abc-123 ' })).toEqual({
      ok: true,
      ticketId: 'ticket:abc-123',
    })
    for (const body of [
      null,
      [],
      {},
      { ticketId: '' },
      { ticketId: '   ' },
      { ticketId: 7 },
      { ticketId: 'has space' },
      { ticketId: 'x'.repeat(129) },
      { ticketId: 't-1', force: true },
    ]) {
      expect(parseUnfreezeTicketBody(body).ok, JSON.stringify(body)).toBe(false)
    }
  })
})
