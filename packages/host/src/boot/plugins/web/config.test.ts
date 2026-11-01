/**
 * `channel:web` 配置面的用例。
 *
 * 两条重点：
 * 1. **fail-loud**：token 入口白名单写错必须在 boot 期就炸，不许"谁都不注入"的静默降级
 *    （页面起来但永远 401 是最难查的一类配置错误）；
 * 2. **未知键仍被拒**：`WebSettings` 没有 admin 键，写 `admin: false` 必须报未知键——
 *    这是 01 §3.6 "admin 无法从配置面开"的结构保证。
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_WEB, parseEntries, parseEntry, parseHandoff, resolveWebSettings } from './config.ts'

describe('token 入口白名单（TC-MCH-17）', () => {
  it.each([
    ['空数组', { entries: [] }],
    ['通配符', { entries: ['*.html'] }],
    ['重复项', { entries: ['a.html', 'a.html'] }],
    ['含点段', { entry: '../x.html' }],
    ['含分隔符', { entries: ['sub/page.html'] }],
    ['非数组', { entries: 'index.html' }],
    ['非字符串项', { entries: [1] }],
    ['不以 .html 结尾', { entries: ['m'] }],
  ])('%s ⇒ 抛 web-invalid-config 且 message 能定位到具体键', (_name, config) => {
    try {
      resolveWebSettings(config)
      expect.unreachable('必须抛错')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('web-invalid-config')
      expect((error as Error).message).toMatch(/entry|entries/)
    }
  })

  it('entry 必须出现在 entries 里（否则 `/` 会返回一个不注入 token 的壳）', () => {
    expect(() => resolveWebSettings({ entry: 'a.html', entries: ['b.html'] })).toThrow(/必须出现在 entries/)
  })

  it('parseEntry：未写用默认值；非字符串 / 通配一律抛', () => {
    expect(parseEntry(undefined)).toBe('index.html')
    expect(() => parseEntry(1)).toThrow(/entry 必须是字符串/)
    expect(() => parseEntry('a?.html')).toThrow(/通配符/)
  })

  it('parseEntries：未写用默认值；返回去重后的数组（顺序保持）', () => {
    // `password.html` 是 ADR-0014 的安全页：它必须拿到 CSRF cookie / Web token 才提交得出去
    expect(parseEntries(undefined)).toEqual(['index.html', 'password.html'])
    expect(parseEntries(['m.html', 'index.html'])).toEqual(['m.html', 'index.html'])
  })
})

describe('未知键拒绝 + 新键被接受 + 默认值（TC-MCH-18）', () => {
  it('未知键 admin 仍被拒（admin 无法从配置面开）', () => {
    expect(() => resolveWebSettings({ entry: 'index.html', admin: false })).toThrow(/未知配置键/)
  })

  it('entry / entries 被接受且出现在结果里', () => {
    const settings = resolveWebSettings({ entry: 'm.html', entries: ['m.html', 'index.html'] })
    expect(settings.entry).toBe('m.html')
    expect(settings.entries).toEqual(['m.html', 'index.html'])
  })

  it('缺省值：entry=index.html、entries=[index.html, password.html]（与 DEFAULT_WEB 一致）', () => {
    const settings = resolveWebSettings({})
    expect(settings.entry).toBe('index.html')
    expect(settings.entries).toEqual(['index.html', 'password.html'])
    expect(settings).toEqual(DEFAULT_WEB)
  })
})

/**
 * `handoff` 段（人机接管 01 新增的键）。
 *
 * 这条是"接管告警多久响"的闸值：写错类型必须 boot 期就炸，
 * 静默回落默认 180s 会让运维以为自己的配置生效了。`0` 是**合法值**（关闭告警），
 * 与 `readPositiveInteger` 的口径不同，所以这里单独钉一次。
 */
describe('handoff.slaMs 校验（0 合法，其余非负整数）', () => {
  it('未写 → 默认 180_000；写 0 → 保留 0（关闭告警，不回落默认）', () => {
    expect(parseHandoff(undefined)).toEqual({ slaMs: 180_000 })
    expect(parseHandoff({})).toEqual({ slaMs: 180_000 })
    expect(parseHandoff({ slaMs: 0 })).toEqual({ slaMs: 0 })
  })

  it('非对象（字符串 / 数组 / null）⇒ web-invalid-config「必须是对象」', () => {
    for (const value of ['180000', [], null]) {
      try {
        parseHandoff(value)
        expect.unreachable('必须抛错')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('web-invalid-config')
        expect((error as Error).message).toContain('handoff 必须是对象')
      }
    }
  })

  it('slaMs 负数 / 小数 / 字符串 ⇒ web-invalid-config（不静默取整或忽略）', () => {
    for (const value of [{ slaMs: -1 }, { slaMs: 1.5 }, { slaMs: '180000' }, { slaMs: Number.NaN }]) {
      try {
        parseHandoff(value)
        expect.unreachable('必须抛错')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('web-invalid-config')
        expect((error as Error).message).toContain('slaMs 必须是非负整数')
      }
    }
  })

  it('整段走 resolveWebSettings 时同样 fail-loud（配置面只有一处判定）', () => {
    expect(() => resolveWebSettings({ handoff: { slaMs: -5 } })).toThrow(/slaMs/)
  })
})
