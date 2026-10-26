/**
 * 路由表 → Markdown（W16 新建）。
 *
 * 为什么渲染器要放在源码里而不是脚本里：`docs/web-frontend.md` §7 的表必须由代码生成，
 * 而"生成结果是否过期"要能在**单测里**判（`web/contract.test.ts`）。渲染器放脚本里，
 * 测试就得反向 import `scripts/`，那不是包的依赖方向。
 *
 * 本模块只做字符串拼接，无副作用、无 IO。
 */

import { ROUTES, type RouteAuth, type RouteSpec } from './router.ts'

/**
 * 鉴权面 → 文档用语。
 *
 * 用 `Record<RouteAuth, …>` 而不是 `switch`：新增一种鉴权面时 TypeScript 直接报缺键，
 * 比运行时 `assertNever` 早一步（门禁 `assert-never` 也不接受无收尾的 switch）。
 */
const AUTH_TEXT: Readonly<Record<RouteAuth, string>> = {
  public: '公开',
  admin: 'admin token + 回环',
  static: '无（静态）',
  web: 'Bearer',
}

/** CSRF 合进同一格，读者一眼能看出哪条写路由有闸。 */
function authText(route: RouteSpec): string {
  const base = AUTH_TEXT[route.auth]
  return route.csrf ? `${base} + CSRF` : base
}

/** 文档里展示的路径（前缀路由用 `display`，它带参数名）。 */
function pathText(route: RouteSpec): string {
  return route.display ?? route.path
}

/** 渲染 GFM 表格（列：方法 / 路径 / 语义 / 鉴权 / 状态码）。 */
export function renderRoutesMarkdown(routes: readonly RouteSpec[] = ROUTES): string {
  const header = ['| 方法 | 路径 | 语义 | 鉴权 | 状态码 |', '|---|---|---|---|---|']
  const rows = routes.map((route) => {
    const methods = route.methods.join(' / ')
    return `| ${methods} | \`${pathText(route)}\` | ${route.note} | ${authText(route)} | ${route.statuses.join(' / ')} |`
  })
  return [...header, ...rows].join('\n')
}
