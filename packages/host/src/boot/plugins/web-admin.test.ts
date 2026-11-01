/**
 * 管理路由的纯函数（HP0-07 + body 边界）。
 *
 * 路由层测"状态码顺序"，这里测"判定本身"——尤其是回环判定：
 * 它是**唯一**把管理面关在本机的那道锁，写宽一点（比如接受 `0.0.0.0`）
 * 就等于把解冻口暴露到局域网。
 */

import { describe, expect, it } from 'vitest'

import {
  ADMIN_OPERATORS_ENV,
  ADMIN_TOKEN_ENV,
  DEFAULT_UNFREEZE_REASON,
  hasAdminCredentials,
  isLoopbackAddress,
  parseHaltBody,
  parseUnfreezeBody,
  parseUnfreezeTicketBody,
  readAdminOperators,
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

describe('HP0-10 解冻体解析（03 TA-44：删掉可伪造的 by）', () => {
  it('空对象 / 只有 reason → 通过（reason 缺省 operator-unfreeze）', () => {
    expect(parseUnfreezeBody({})).toEqual({ ok: true, reason: DEFAULT_UNFREEZE_REASON })
    expect(parseUnfreezeBody({ reason: '客服复核：误报' })).toEqual({
      ok: true,
      reason: '客服复核：误报',
    })
  })

  it('非对象 → 400 语义', () => {
    for (const body of [null, [], 'x']) {
      const parsed = parseUnfreezeBody(body)
      expect(parsed.ok, JSON.stringify(body)).toBe(false)
    }
  })

  it('`by` 与任何未知键一律 400（操作者从 token 派生，不接受自报）', () => {
    const parsed = parseUnfreezeBody({ by: 'ops-7' })
    expect(parsed).toEqual({
      ok: false,
      code: 'web-admin-invalid-body',
      detail: '未知字段：by',
    })
    expect(parseUnfreezeBody({ by: 'ops-7', reason: 'x' })).toMatchObject({ ok: false })
    expect(parseUnfreezeBody({ nope: 1 })).toMatchObject({ ok: false, detail: '未知字段：nope' })
  })

  it('超长 reason 拒绝', () => {
    expect(parseUnfreezeBody({ reason: 'x'.repeat(201) }).ok).toBe(false)
  })

  it('reason 存在但非字符串 → 类型专属文案（与"超长"是两种错，审计与 CLI 文案都靠 code+detail 区分）', () => {
    // 为什么要逐形态钉：`reason: null` / 对象 / 数组 / 数字都会被 `!== undefined`
    // 放行到类型检查这一步；若这里退化成缺省值或超长文案，管理面就把"客户端写错"
    // 与"内容过长"混成同一条信息，排障时无从判断该改哪边。
    for (const reason of [42, true, null, {}, ['K1'], () => 'x']) {
      expect(parseUnfreezeBody({ reason })).toEqual({
        ok: false,
        code: 'web-admin-invalid-body',
        detail: 'reason 必须是字符串',
      })
    }
  })
})

describe('03 TA-44 · 操作员表（token → id）', () => {
  const env = (operators: unknown): Record<string, string | undefined> => ({
    [ADMIN_OPERATORS_ENV]: JSON.stringify(operators),
  })

  it('04 §1.2：hasAdminCredentials 只看"配没配"，不解析 JSON', () => {
    expect(hasAdminCredentials({})).toBe(false)
    expect(hasAdminCredentials({ [ADMIN_TOKEN_ENV]: '   ' })).toBe(false)
    expect(hasAdminCredentials({ [ADMIN_TOKEN_ENV]: 'tok' })).toBe(true)
    expect(hasAdminCredentials({ [ADMIN_OPERATORS_ENV]: '[{"id":"a","token":"t"}]' })).toBe(true)
    // 坏 JSON 也算"配了"：启动告警看的是"有没有管理面"，不是配置对不对
    expect(hasAdminCredentials({ [ADMIN_OPERATORS_ENV]: '{bad' })).toBe(true)
  })

  it('两个操作员：id/token 原样读出', () => {
    const parsed = readAdminOperators(
      env([
        { id: 'ops-li', token: 'tok-li' },
        { id: 'ops-wang', token: 'tok-wang' },
      ]),
    )
    expect(parsed).toEqual({
      ok: true,
      operators: [
        { id: 'ops-li', token: 'tok-li' },
        { id: 'ops-wang', token: 'tok-wang' },
      ],
    })
  })

  it('兼容：只配 BAH_ADMIN_TOKEN → [{id:"admin"}]；都不配 → 空表（路由 404）', () => {
    expect(readAdminOperators({ [ADMIN_TOKEN_ENV]: 'legacy-token' })).toEqual({
      ok: true,
      operators: [{ id: 'admin', token: 'legacy-token' }],
    })
    expect(readAdminOperators({})).toEqual({ ok: true, operators: [] })
  })

  it('两表都配时操作员表优先（禁止 body 回退的第二真相源）', () => {
    const parsed = readAdminOperators({
      [ADMIN_TOKEN_ENV]: 'legacy-token',
      [ADMIN_OPERATORS_ENV]: JSON.stringify([{ id: 'ops-li', token: 'tok-li' }]),
    })
    expect(parsed).toEqual({ ok: true, operators: [{ id: 'ops-li', token: 'tok-li' }] })
  })

  it('坏配置 fail-loud（ok:false 由 guardAdmin 回 503，不静默当没配）', () => {
    for (const raw of ['{not json', '[]', '{"id":"x"}', '[{"id":"x"}]', '[{"id":"x","token":""}]']) {
      const parsed = readAdminOperators({ [ADMIN_OPERATORS_ENV]: raw })
      expect(parsed.ok, raw).toBe(false)
    }
    expect(readAdminOperators(env([{ id: 'x', token: 't', extra: 1 }]))).toMatchObject({ ok: false })
    expect(readAdminOperators(env([{ id: 'bad id', token: 't' }]))).toMatchObject({ ok: false })
    expect(
      readAdminOperators(
        env([
          { id: 'same', token: 't1' },
          { id: 'same', token: 't2' },
        ]),
      ),
    ).toMatchObject({ ok: false })
    expect(
      readAdminOperators(
        env([
          { id: 'a', token: 'same' },
          { id: 'b', token: 'same' },
        ]),
      ),
    ).toMatchObject({ ok: false })
  })

  it('数组项不是对象（null / 字符串 / 嵌套数组）⇒ 明确指到变量名与"每一项必须是对象"', () => {
    // 这一条在 `for (const key of Object.keys(item))` 之前：少它的话 `Object.keys(null)`
    // 会先抛 TypeError，管理面变成 500 而不是可判别的 503。
    for (const raw of ['[null]', '["ops-li"]', '[[1,2]]', '[{}]']) {
      const parsed = readAdminOperators({ [ADMIN_OPERATORS_ENV]: raw })
      expect(parsed.ok, raw).toBe(false)
    }
    expect(readAdminOperators(env([null]))).toMatchObject({
      ok: false,
      reason: `${ADMIN_OPERATORS_ENV} 的每一项必须是对象`,
    })
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
