/**
 * 门禁：授权覆盖率（租户与鉴权 03 · TA-49）。
 *
 * ## 为什么需要它
 *
 * 越权最常见的两个来源都不是"写错判定"，而是：
 * 1. **新路由忘了声明角色**——`auth: 'web'` 一写，默认就只要求"已认证"；
 * 2. **handler 里顺手判了一下角色**——第二处判定必然与 `authorize()` 分叉，
 *    而"哪处生效"没人说得清（Z1）。
 *
 * 本门禁把这两件事变成机械检查。判据 3 再补一条：主体只能来自服务端解析，
 * 全仓不许从请求头/查询参数取 `x-tenant` / `x-user-id` / `x-role` / `?as=`（Z3）。
 *
 * ## 判据
 *
 * | # | 判据 | 反例 |
 * |---|---|---|
 * | 1 | `router.ts` 的 `ROUTES` 里：`auth:'web'` 必须有 `roles`；非 web 不许有 | `{ auth: 'web' }` |
 * | 2 | `web/handlers/*.ts` 不许出现角色判定 | `principal.roles.includes('admin')` |
 * | 3 | 全仓源码不许信任客户端主体头 | `req.headers['x-tenant']` |
 * | 4 | `--self-test` 用坏样本证明三条判据都能红 | 见 `selfTest` |
 *
 * 判据 1 用 TypeScript AST（仓库已有依赖）：正则数括号在路由表长到 20 条之后
 * 一定会漏，而漏掉的那条就是"没声明角色"的那条。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 路由表（判据 1 的检查面）。 */
const ROUTER_PATH = 'packages/host/src/boot/plugins/web/router.ts'

/** 业务 handler 目录（判据 2 的检查面）。 */
const HANDLER_DIR = 'packages/host/src/boot/plugins/web/handlers'

/** 合法角色（与 `@bah/util` 的 `ROLES` 同集；这里不 import，避免门禁依赖包构建产物）。 */
const ROLES = ['customer', 'agent', 'auditor', 'admin'] as const

/** 判据 2：角色判定的形态。 */
const ROLE_JUDGMENT_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\broles\s*\.\s*(?:includes|some|every|find|filter|indexOf)\s*\(/,
    why: 'handler 里直接判角色',
  },
  { pattern: /\bhasRole\s*\(/, why: 'handler 里出现 hasRole()' },
  { pattern: /\bisAdmin\b/, why: 'handler 里出现 isAdmin' },
  {
    pattern: /\brole\s*===?\s*['"](?:customer|agent|auditor|admin)['"]/,
    why: 'handler 里把角色与字面量比较',
  },
]

/** 判据 3：客户端主体声明（Z3）。 */
const CLIENT_SUBJECT_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /headers\s*\[\s*['"]x-(?:tenant|user-id|role)['"]\s*\]/i,
    why: "从请求头取主体（headers['x-...']）",
  },
  {
    pattern: /headers\s*\.\s*(?:get|has)\s*\(\s*['"]x-(?:tenant|user-id|role)['"]\s*\)/i,
    why: "从请求头取主体（headers.get('x-...')）",
  },
  {
    pattern: /searchParams\s*\.\s*get\s*\(\s*['"]as['"]\s*\)/,
    why: "从查询参数冒充主体（searchParams.get('as')）",
  },
  { pattern: /[?&]as=\$\{/, why: '把 ?as= 拼进请求（主体只能来自服务端解析）' },
]

/** 去注释（本仓注释里故意写着反例；不剥会把纪律本身判成违规）。 */
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', index)
      index = nl < 0 ? source.length : nl
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          out += source.slice(index, index + 2)
          index += 2
          continue
        }
        out += source[index]
        if (source[index] === quote) break
        index += 1
      }
      index += 1
      continue
    }
    out += ch
    index += 1
  }
  return out
}

/** 行号（1 基）。 */
function lineOf(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

/** 取对象字面量的某个属性。 */
function propertyOf(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return node.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText() === name,
  )
}

/** 判据 1：路由表角色声明。 */
export function judgeRouteSource(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  let routes: ts.ArrayLiteralExpression | undefined
  file.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return
    for (const declaration of node.declarationList.declarations) {
      if (
        declaration.name.getText() === 'ROUTES' &&
        declaration.initializer !== undefined &&
        ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        routes = declaration.initializer
      }
    }
  })
  if (routes === undefined) {
    // 门禁失明比误报更危险：找不到表就红
    return [`${path} 找不到 \`ROUTES\` 数组——判据 1 失明，先修门禁`]
  }

  const findings: string[] = []
  for (const element of routes.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue
    const line = file.getLineAndCharacterOfPosition(element.getStart(file)).line + 1
    const pathValue = propertyOf(element, 'path')
    const routePath =
      pathValue !== undefined && ts.isStringLiteral(pathValue.initializer)
        ? pathValue.initializer.text
        : '?'
    const authValue = propertyOf(element, 'auth')
    const auth =
      authValue !== undefined && ts.isStringLiteral(authValue.initializer)
        ? authValue.initializer.text
        : undefined
    const roles = propertyOf(element, 'roles')

    if (auth === 'web' && roles === undefined) {
      findings.push(
        `${path}:${String(line)} ${routePath} 是 auth:'web' 但没有 roles——默认只要求已认证，新增路由最容易漏在这里`,
      )
    }
    if (auth !== 'web' && roles !== undefined) {
      findings.push(
        `${path}:${String(line)} ${routePath} 是 ${String(auth)}，不该声明 roles（公开/管理面/静态没有角色概念）`,
      )
    }
    if (roles === undefined) continue

    const initializer = roles.initializer
    if (ts.isIdentifier(initializer) && initializer.text === 'ROLES') continue
    if (!ts.isArrayLiteralExpression(initializer)) {
      findings.push(`${path}:${String(line)} ${routePath} 的 roles 必须是数组字面量或 ROLES`)
      continue
    }
    if (initializer.elements.length === 0) {
      findings.push(`${path}:${String(line)} ${routePath} 的 roles 是空数组（等于永远 403）`)
    }
    for (const role of initializer.elements) {
      if (!ts.isStringLiteral(role)) {
        findings.push(`${path}:${String(line)} ${routePath} 的 roles 必须是字符串字面量`)
        continue
      }
      if (!(ROLES as readonly string[]).includes(role.text)) {
        findings.push(`${path}:${String(line)} ${routePath} 出现未知角色 ${JSON.stringify(role.text)}`)
      }
    }
  }
  return findings
}

/** 判据 2：handler 里不许判角色。 */
export function judgeHandlerSource(path: string, source: string): string[] {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized.startsWith(`${HANDLER_DIR}/`) || normalized.endsWith('.test.ts')) return []
  const findings: string[] = []
  for (const { pattern, why } of ROLE_JUDGMENT_PATTERNS) {
    const match = pattern.exec(source)
    if (match === null) continue
    findings.push(
      `${path}:${String(lineOf(source, match.index))} ${why}——角色判定只允许在 web/authz/authorize.ts（Z1，两处判定必然分叉）`,
    )
  }
  return findings
}

/** 判据 3：不许信任客户端主体声明。 */
export function judgeClientSubject(path: string, source: string): string[] {
  const normalized = path.replaceAll('\\', '/')
  if (normalized.endsWith('.test.ts')) return []
  // 其他门禁的自检样本里故意写着这些字符串；它们不是运行时路径
  if (normalized.startsWith('scripts/verify-')) return []
  const findings: string[] = []
  for (const { pattern, why } of CLIENT_SUBJECT_PATTERNS) {
    const match = pattern.exec(source)
    if (match === null) continue
    findings.push(
      `${path}:${String(lineOf(source, match.index))} ${why}——主体只能来自服务端解析（Z3）`,
    )
  }
  return findings
}

/** 对一个文件跑判据 2/3。 */
function judgeFile(path: string, raw: string): string[] {
  const source = stripComments(raw)
  return [...judgeHandlerSource(path, source), ...judgeClientSubject(path, source)]
}

const gate: Gate = {
  name: 'authz-coverage',

  async run(root) {
    const findings: string[] = []
    const notes: string[] = []

    const routerPath = join(root, ROUTER_PATH)
    try {
      findings.push(...judgeRouteSource(ROUTER_PATH, readFileSync(routerPath, 'utf8')))
    } catch {
      findings.push(`${ROUTER_PATH} 读不到——判据 1 失明，先修门禁`)
    }

    const files = walk(root, ['packages', 'apps', 'services', 'scripts'], (name) => {
      return (name.endsWith('.ts') || name.endsWith('.js')) && !name.endsWith('.d.ts')
    })
    for (const path of files) {
      const relative = path.slice(root.length + 1).replaceAll('\\', '/')
      // 本门禁的自检样本里故意写着坏代码
      if (relative === 'scripts/verify-authz-coverage.ts') continue
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      findings.push(...judgeFile(relative, raw))
    }

    notes.push(
      `路由表 1 份；扫描 ${String(files.length)} 个源码文件；判据 2（handler 角色判定）、判据 3（客户端主体声明）`,
    )
    return { ok: findings.length === 0, findings, notes }
  },
}

/**
 * 自检：坏样本必须被三条判据分别抓到；合法样本不许误报。
 *
 * @returns 不符项数（0 = 自检通过）
 */
export function selfTest(): number {
  const bad: readonly {
    readonly name: string
    readonly judge: () => string[]
  }[] = [
    {
      name: 'web 路由缺 roles',
      judge: () =>
        judgeRouteSource(
          'router.ts',
          `const ROUTES = [{ methods: ['GET'], path: '/api/x', kind: 'exact', auth: 'web', csrf: false, statuses: [200], handler: 'x', note: 'x' }]\n`,
        ),
    },
    {
      name: '非 web 路由声明 roles',
      judge: () =>
        judgeRouteSource(
          'router.ts',
          `const ROUTES = [{ methods: ['GET'], path: '/api/x', kind: 'exact', auth: 'public', roles: ['admin'], csrf: false, statuses: [200], handler: 'x', note: 'x' }]\n`,
        ),
    },
    {
      name: '未知角色',
      judge: () =>
        judgeRouteSource(
          'router.ts',
          `const ROUTES = [{ methods: ['GET'], path: '/api/x', kind: 'exact', auth: 'web', roles: ['root'], csrf: false, statuses: [200], handler: 'x', note: 'x' }]\n`,
        ),
    },
    {
      name: 'handler 里判角色',
      judge: () =>
        judgeHandlerSource(
          'packages/host/src/boot/plugins/web/handlers/fake.ts',
          `if (identity.principal.roles.includes('admin')) { sendJson(res, 200, {}) }\n`,
        ),
    },
    {
      name: 'handler 里比较角色字面量',
      judge: () =>
        judgeHandlerSource(
          'packages/host/src/boot/plugins/web/handlers/fake.ts',
          `if (role === 'auditor') return\n`,
        ),
    },
    {
      name: '从请求头取主体',
      judge: () =>
        judgeClientSubject(
          'packages/host/src/boot/plugins/fake.ts',
          `const tenant = req.headers['x-tenant']\n`,
        ),
    },
    {
      name: '从查询参数冒充主体',
      judge: () =>
        judgeClientSubject('apps/web/src/fake.js', `const as = url.searchParams.get('as')\n`),
    },
  ]

  let missed = 0
  for (const sample of bad) {
    const findings = sample.judge()
    if (findings.length === 0) {
      missed += 1
      console.error(`✘ 自检失败：坏样本未被抓到 —— ${sample.name}`)
    } else {
      console.log(`✔ 抓到（${String(findings.length)} 条）：${sample.name}`)
    }
  }

  const good: readonly { readonly name: string; readonly judge: () => string[] }[] = [
    {
      name: 'web 路由声明了 roles',
      judge: () =>
        judgeRouteSource(
          'router.ts',
          `const ROUTES = [{ methods: ['GET'], path: '/api/x', kind: 'exact', auth: 'web', roles: ['customer', 'agent'], csrf: false, statuses: [200], handler: 'x', note: 'x' }]\n`,
        ),
    },
    {
      name: '全部角色用 ROLES',
      judge: () =>
        judgeRouteSource(
          'router.ts',
          `const ROUTES = [{ methods: ['GET'], path: '/api/x', kind: 'exact', auth: 'web', roles: ROLES, csrf: false, statuses: [200], handler: 'x', note: 'x' }]\n`,
        ),
    },
    {
      name: 'handler 只回显角色',
      judge: () =>
        judgeHandlerSource(
          'packages/host/src/boot/plugins/web/handlers/fake.ts',
          `sendJson(res, 200, { roles: [...identity.principal.roles] })\n`,
        ),
    },
    {
      name: '只读 Authorization 头',
      judge: () =>
        judgeClientSubject(
          'packages/host/src/boot/plugins/fake.ts',
          `const auth = req.headers.authorization\n`,
        ),
    },
  ]

  for (const sample of good) {
    const findings = sample.judge()
    if (findings.length > 0) {
      missed += 1
      console.error(`✘ 自检失败：合法样本被误报 —— ${sample.name}`)
    } else {
      console.log(`✔ 未误报：${sample.name}`)
    }
  }

  console.log(
    missed === 0
      ? `自检通过：${String(bad.length)} 条坏样本全部被抓、${String(good.length)} 条合法样本未被误报`
      : `自检失败：${String(missed)} 项不符`,
  )
  return missed
}

export { gate }

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) {
    process.exitCode = selfTest() === 0 ? 0 : 1
  } else {
    await runStandalone(gate)
  }
}
