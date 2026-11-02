/**
 * W16 拆分证据（路由表快照 + 结构预算）。
 *
 * 为什么单独一个文件而不是往 `web.test.ts` 里加：`web.test.ts` 的 53 例是**行为基线**，
 * 本设计最值钱的证据恰恰是"这 53 例一个字都没改就全绿"。把它和新断言混在一起，
 * 下次审 diff 就分不清"改了行为"还是"加了断言"。
 *
 * 两条断言的价值分工：
 * - 路由表快照：方法/路径/状态码三元组一条不许变（含 403 那两行——CSRF 被搬家搬丢时最先消失的就是它）；
 * - 结构预算：`apply` 与 handler 的行数上限，防"拆完又慢慢长回去"。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { matchRoute, ROUTES, assertRouteRoles } from './router.ts'
import { renderRoutesMarkdown } from './routes-markdown.ts'

/** 读同目录/上级目录的源码（`web.ts` 在上一层）；统一换行，免得 CRLF 让整行比较失效。 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}

/** 按 `wc -l` 口径数行数（末尾换行不多算一行）。 */
function countLines(text: string): number {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

/** 一条路由压成可比对的一行：方法|路径|匹配方式|鉴权面|CSRF|状态码|处理器。 */
function fingerprint(route: (typeof ROUTES)[number]): string {
  return [
    route.methods.join('|'),
    route.path,
    route.kind,
    route.auth,
    route.csrf ? 'csrf' : 'no-csrf',
    route.statuses.join(','),
    route.handler,
  ].join(' ')
}

describe('W16 路由表（拆分前后同一份期望）', () => {
  it('30 条路由的三元组逐条不变（19 条 main 基线 + 3 条认证 + 5 条人机接管 + 1 条指标 + 1 条改密 + 2 条历史）', () => {
    expect(ROUTES.map(fingerprint)).toEqual([
      'GET /api/health exact public no-csrf 200 health',
      // 02 新增：登录是**公开但受 CSRF 管**的路由（登录 CSRF 是真实攻击面）
      'POST /api/auth/login exact public csrf 200,400,401,403,409,503 login',
      'POST /api/auth/logout exact public csrf 200,403 logout',
      'GET /api/auth/me exact web no-csrf 200,401 me',
      'POST /api/admin/sentry/unfreeze exact admin no-csrf 200,400,401,403,404,405,503 admin',
      'POST /api/admin/halt exact admin no-csrf 200,400,401,403,404,405,503 admin',
      'POST /api/admin/halt/unfreeze-request exact admin no-csrf 200,400,401,403,404,405,409,503 admin',
      'POST /api/admin/halt/unfreeze exact admin no-csrf 200,400,401,403,404,405,409,503 admin',
      'GET /api/session exact web no-csrf 200,401 session',
      'GET /api/events exact web no-csrf 200,400,401,503 events',
      // D2 新增：单机指标（只读，Bearer 与其它业务路由同闸）
      'GET /api/metrics exact web no-csrf 200,400,401 metrics',
      // 02 新增：轨迹森林 / Chrome Trace（只读，Bearer 同闸；400 = format/limit 非法）
      'GET /api/trace exact web no-csrf 200,400,401,503 trace',
      // 04 新增：回到上一步 = 在 turn 边界分叉新会话（旧会话原样封存）
      'POST /api/session/fork exact web csrf 200,400,401,403,404,405,409,500 fork',
      // 历史会话（只读，2026-11-02）：prefix 必须排在 exact 之前，见 router.ts 的注释
      'GET /api/sessions/ prefix web no-csrf 200,400,401,404,503 session-read',
      'GET /api/sessions exact web no-csrf 200,400,401,503 sessions',
      // 合流：客户/坐席分离改由 roles 表达，`auth` 只剩 public/admin/web/static 四种
      // 客户专属（D3）：坐席不能替客户发消息 / 打断 / 放行 / 强验证
      'POST /api/turn exact web csrf 202,400,401,403,423,503 turn',
      'POST /api/suggest exact web csrf 200,400,401,403,503 suggest',
      'POST /api/interrupt exact web csrf 200,401,403,503 interrupt',
      'POST /api/approval/ prefix web csrf 200,400,401,403,404,409 approval',
      'POST /api/verify/ prefix web csrf 200,400,401,403,404 verify',
      // 01 单（ADR-0014）：安全页改密（**明文只走这一条**，载荷里没有任何密码字段）
      'POST /api/secure/password exact web csrf 200,400,401,403,404,409,423 secure-password',
      // C5：客户侧三条（读摘要 / 请求接管 / 交回）
      'GET /api/handoff exact web no-csrf 200,401 handoff',
      'POST /api/handoff exact web csrf 200,400,401,403,409 handoff',
      'POST /api/handoff/resume exact web csrf 200,400,401,403,409 handoff',
      // 人机接管 01：坐席侧四条（发言 / 认领 / 心跳 / 队列）；坐席未启用一律 404
      'POST /api/handoff/message exact web csrf 200,400,401,403,404,409,413 handoff-message',
      'POST /api/handoff/claim exact web csrf 200,401,403,404,409 handoff-claim',
      'POST /api/handoff/heartbeat exact web csrf 200,401,403,404 handoff-heartbeat',
      'GET /api/handoff/queue exact web no-csrf 200,401,403,404 handoff-queue',
      // 人机接管 02：坐席工作台入口（static ⇒ 页面能打开才能输凭证；零注入）
      'GET /operator exact static no-csrf 200,404 static',
      // 400 是 D6 新增：畸形百分号编码（`%E0%A4%A`）以前冒成 500
      'GET|HEAD / prefix static no-csrf 200,400,404 static',
    ])
  })

  it('每个受 CSRF 管的路由都必须列 403：搬丢闸时最先消失的就是这一行', () => {
    const guarded = ROUTES.filter((route) => route.csrf)
    expect(guarded.map((route) => `${route.handler} ${route.path}`)).toEqual([
      // 02：登录本身也过 CSRF（否则"登录 CSRF"：攻击者让受害者登录攻击者的账户）
      'login /api/auth/login',
      'logout /api/auth/logout',
      'fork /api/session/fork',
      'turn /api/turn',
      'suggest /api/suggest',
      'interrupt /api/interrupt',
      'approval /api/approval/',
      'verify /api/verify/',
      'secure-password /api/secure/password',
      'handoff /api/handoff',
      'handoff /api/handoff/resume',
      'handoff-message /api/handoff/message',
      'handoff-claim /api/handoff/claim',
      'handoff-heartbeat /api/handoff/heartbeat',
    ])
    for (const route of guarded) expect(route.statuses).toContain(403)
  })

  it('管理面一律豁免 CSRF，且方法交给闸自己判（否则方法错会变成 404）', () => {
    for (const route of ROUTES.filter((item) => item.auth === 'admin')) {
      expect(route.csrf).toBe(false)
      expect(route.methodInHandler).toBe(true)
      expect(route.statuses).toContain(405)
    }
  })

  it('状态码升序且不重复（钉住手写表的笔误）', () => {
    for (const route of ROUTES) {
      const sorted = [...route.statuses].sort((a, b) => a - b)
      expect(route.statuses).toEqual(sorted)
      expect(new Set(route.statuses).size).toBe(route.statuses.length)
    }
  })

  it('公开路由只有探活、登录与登出（02 起多两条；两条写路由都受 CSRF 管）', () => {
    expect(ROUTES.filter((route) => route.auth === 'public').map((route) => route.path)).toEqual([
      '/api/health',
      '/api/auth/login',
      // 登出必须幂等（第二次没有会话也 200）⇒ 不能要求主体；防"跨站强制登出"靠 CSRF
      '/api/auth/logout',
    ])
  })

  it('匹配优先级：精确业务路由先于静态兜底', () => {
    expect(matchRoute('GET', '/api/session')?.spec.handler).toBe('session')
    expect(matchRoute('GET', '/api/health')?.spec.handler).toBe('health')
    // 未知 GET 落到静态兜底（带凭证后是 404，不是 405）；未知 POST 不命中任何路由（→ 405）
    expect(matchRoute('GET', '/api/unknown')?.spec.handler).toBe('static')
    expect(matchRoute('POST', '/api/unknown')).toBeUndefined()
    expect(matchRoute('PUT', '/')).toBeUndefined()
  })

  it('管理面按路径命中、按方法拒绝（HP-0 的状态码顺序）', () => {
    expect(matchRoute('GET', '/api/admin/halt')?.spec.handler).toBe('admin')
    expect(matchRoute('DELETE', '/api/admin/halt/unfreeze')?.spec.handler).toBe('admin')
    // 前缀不当成管理面：`/api/admin/haltx` 不是管理路由
    expect(matchRoute('POST', '/api/admin/haltx')?.spec.handler ?? 'none').toBe('none')
  })

  it('前缀路由交出尾段（票据 ID 的取法不变）', () => {
    expect(matchRoute('POST', '/api/approval/t-1')?.rest).toBe('t-1')
    expect(matchRoute('POST', '/api/approval/')?.rest).toBe('')
    expect(matchRoute('POST', '/api/turn')?.rest).toBe('')
  })

  it('每条路由都有语义（生成表不许出现空格子）', () => {
    for (const route of ROUTES) {
      expect(route.note.trim().length, `${route.path} 缺 note`).toBeGreaterThan(0)
    }
  })

  it('文档 §7 的表与代码生成结果逐字一致（表过期即红）', () => {
    const doc = readSource('../../../../../../docs/web-frontend.md')
    const begin = '<!-- web-routes:begin -->'
    const end = '<!-- web-routes:end -->'
    const start = doc.indexOf(begin)
    const stop = doc.indexOf(end)
    expect(start, '文档里缺少 web-routes:begin 标记').toBeGreaterThan(-1)
    expect(stop, '文档里缺少 web-routes:end 标记').toBeGreaterThan(start)
    // 重生成命令：npx tsx scripts/web-routes.ts
    expect(doc.slice(start + begin.length, stop).trim()).toBe(renderRoutesMarkdown().trim())
  })
})

describe('W16 结构预算', () => {
  it('handler 均 < 200 行', () => {
    const files = [
      'handlers/session.ts',
      'handlers/approval.ts',
      'handlers/admin.ts',
      'handlers/static.ts',
      'handlers/metrics.ts',
      'handlers/prometheus.ts',
      'handlers/trace.ts',
      'handlers/handoff.ts',
    ]
    for (const file of files) {
      const lines = countLines(readSource(`./${file}`))
      expect(lines, `${file} 超过 200 行（${String(lines)}）`).toBeLessThan(200)
    }
  })

  it('web.ts 总行数 ≤ 200（拆分前 916）', () => {
    expect(countLines(readSource('../web.ts'))).toBeLessThanOrEqual(200)
  })

  it('apply 本体 ≤ 120 行（拆分前 622）', () => {
    const lines = readSource('../web.ts').split('\n')
    const start = lines.findIndex((line) => line.includes('async apply(ctx, config) {'))
    expect(start).toBeGreaterThanOrEqual(0)
    // apply 的收尾是 4 空格缩进的 `},`（2 空格那个关的是 plugin 对象）
    const end = lines.findIndex((line, index) => index > start && line === '    },')
    expect(end).toBeGreaterThan(start)
    expect(end - start + 1).toBeLessThanOrEqual(120)
  })

  it('web/ 下没有反向 import web.ts（否则 web.ts → dispatch → handler → web.ts 成环）', () => {
    const files = [
      'admin-guard.ts',
      'config.ts',
      'csrf.ts',
      'deps.ts',
      'dispatch.ts',
      'http.ts',
      'listen.ts',
      'router.ts',
      'routes-markdown.ts',
      'sse.ts',
      'handlers/session.ts',
      'handlers/approval.ts',
      'handlers/admin.ts',
      'handlers/static.ts',
    ]
    for (const file of files) {
      const source = readSource(`./${file}`)
      expect(/from\s+['"][^'"]*\bweb\.ts['"]/.test(source), `${file} 反向 import 了 web.ts`).toBe(
        false,
      )
    }
  })
})

describe('03 TA-40 · 路由角色声明（增量，不改既有元素）', () => {
  it('TA-40-1 每条 auth:web 的路由都有 roles；其余一律不写', () => {
    for (const route of ROUTES) {
      if (route.auth === 'web') {
        expect(route.roles, `${route.path} 缺 roles`).toBeDefined()
        expect(route.roles!.length, `${route.path} 的 roles 为空`).toBeGreaterThan(0)
      } else {
        expect(route.roles, `${route.path}（${route.auth}）不该有 roles`).toBeUndefined()
      }
    }
  })

  it('TA-40-2 未知角色 / 空数组 / 重复 / 顺序错 → assertRouteRoles 抛错', () => {
    expect(() => assertRouteRoles('/api/x', ['root'] as never)).toThrow(/未知角色/)
    expect(() => assertRouteRoles('/api/x', [])).toThrow(/不允许空数组/)
    // 重复角色会让主体序列化的字节不唯一：同一组角色算出两个审计主体
    expect(() => assertRouteRoles('/api/x', ['customer', 'customer'])).toThrow(/角色重复/)
    expect(() => assertRouteRoles('/api/x', ['admin', 'customer'])).toThrow(/ROLES 序/)
  })

  it('TA-40-3 指纹里没有角色信息（既有 19 行快照仍是唯一基线）', () => {
    expect(ROUTES.map(fingerprint).join('\n')).not.toContain('customer')
  })
})
