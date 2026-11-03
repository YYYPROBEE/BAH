/**
 * 门禁：Web 前端的硬约束。
 *
 * 1. **纯原生**：`apps/web` 不得依赖框架 / UI 组件库（在 `package.json` 与源码 import 两处查）；
 * 2. **零远程资源**：`src` / `href` / `url()` 里不得出现 `http(s)://`（离线演示、供应链最小面）；
 * 3. **令牌同步**：`apps/web/styles/ds/*.css` 必须与 `design/bah-ds/*.css` 逐字节一致；
 * 4. **令牌纪律**：页面局部样式（`styles/*.css`，排除 `ds/` 副本）不得出现裸色值，只能用 `var(--…)`；
 * 5. **按入口判样式**：每个 HTML 壳挂**它自己的**那份页面 CSS（桌面两个挂 `app.css`、移动壳挂
 *    `mobile.css`），且模块入口文件真实存在；未登记的入口页一律判红。
 *
 * 为什么第 3 条必须门禁：`design/bah-ds` 是自研视觉基线的唯一定义处，`styles/ds` 是它的分发副本。
 * 没有这条，半年后没人说得清页面上的圆角到底是哪一版令牌。
 *
 * 为什么第 5 条要按入口而不是"所有 HTML 都挂 app.css"：移动壳 `m.html` 挂的是 `mobile.css`——
 * 一刀切会把移动壳判红；反过来只看"有没有 CSS"又会放过漏挂（页面起来但样式全丢）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 前端根目录。 */
const WEB_DIR = join('apps', 'web')

/** 自研设计基线根目录（令牌的唯一定义处）。 */
const DESIGN_DIR = join('design', 'bah-ds')

/** 需要逐字节同步的文件。 */
const SYNCED = [
  { upstream: join(DESIGN_DIR, 'colors_and_type.css'), copy: join(WEB_DIR, 'styles', 'ds', 'colors_and_type.css') },
  { upstream: join(DESIGN_DIR, 'components.css'), copy: join(WEB_DIR, 'styles', 'ds', 'components.css') },
]

/** 禁止的框架 / 组件库（前缀匹配，覆盖 scoped 包）。 */
const FORBIDDEN = [
  'vue',
  '@vue/',
  'react',
  'react-dom',
  '@angular/',
  'svelte',
  'lit',
  'lit-html',
  'preact',
  'solid-js',
  'alpinejs',
  'jquery',
  'htmx.org',
  'bootstrap',
  'tailwindcss',
  '@mui/',
  'antd',
  'element-plus',
  '@chakra-ui/',
]

/** 每个入口页都必须挂的两份设计令牌。 */
const DS_STYLES = ['./styles/ds/colors_and_type.css', './styles/ds/components.css'] as const

/**
 * 每个已登记入口的必需样式。
 *
 * **新增 HTML 壳必须先在这里登记**：未登记的 `.html` 会被门禁判红，而不是"只要有 CSS 就行"。
 */
const REQUIRED_STYLES: Readonly<Record<string, readonly string[]>> = {
  'index.html': [...DS_STYLES, './styles/app.css'],
  'operator.html': [...DS_STYLES, './styles/app.css'],
  'm.html': [...DS_STYLES, './styles/mobile.css'],
  // 交易密码安全页（ADR-0014）：复用 `app.css`（登录卡样式），不新开一份页面局部样式
  'password.html': [...DS_STYLES, './styles/app.css'],
}

/** 读文件（失败返回 `undefined`）。 */
function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** sha256。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 是否是远程 URL。 */
function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

/** 只扫前端源码与样式。 */
const isWebSource = (fileName: string): boolean =>
  /\.(js|mjs|css|html)$/.test(fileName) && !fileName.endsWith('.test.js')

const gate: Gate = {
  name: 'web',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    // ① 纯原生：package.json 依赖
    const pkgRaw = read(join(root, WEB_DIR, 'package.json'))
    if (pkgRaw === undefined) {
      findings.push(`${WEB_DIR}/package.json 不存在（前端包定义丢失）`)
    } else {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        for (const name of Object.keys(pkg[group] ?? {})) {
          const hit = FORBIDDEN.find((prefix) => name === prefix || name.startsWith(prefix))
          if (hit !== undefined) findings.push(`${WEB_DIR}/package.json: 依赖 ${name} 属于被禁止的框架/组件库`)
        }
      }
    }

    // ② 源码：import 与远程资源
    const files = walk(root, [WEB_DIR], isWebSource)
    for (const file of files) {
      const where = relative(root, file).split('\\').join('/')
      const text = read(file) ?? ''

      for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? ''
        const hit = FORBIDDEN.find((prefix) => specifier === prefix || specifier.startsWith(prefix))
        if (hit !== undefined) findings.push(`${where}: 引入了 ${specifier}（纯原生约束）`)
      }

      const remotePattern = /(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']|url\(\s*["']?(https?:\/\/[^)"']+)/gi
      for (const match of text.matchAll(remotePattern)) {
        const url = match[1] ?? match[2] ?? ''
        if (isRemote(url)) findings.push(`${where}: 引用了远程资源 ${url}（必须本地化）`)
      }
    }
    notes.push(`已扫描 ${String(files.length)} 个前端文件`)

    // ③ 令牌同步
    for (const pair of SYNCED) {
      const upstream = read(join(root, pair.upstream))
      const copy = read(join(root, pair.copy))
      if (upstream === undefined) {
        findings.push(`${pair.upstream}: 自研基线缺失（design/bah-ds 是令牌的唯一定义处）`)
        continue
      }
      if (copy === undefined) {
        findings.push(`${pair.copy}: 分发副本缺失（运行 cp ${pair.upstream} ${pair.copy}）`)
        continue
      }
      if (sha256(upstream) !== sha256(copy)) {
        findings.push(`${pair.copy}: 与 ${pair.upstream} 不一致（改了一处必须同步另一处）`)
      }
    }

    // ④ 令牌纪律：页面局部样式（styles/*.css，排除 ds/ 副本）不得出现裸色值；
    //    同时校验 `--icon-url` 指向的本地图标真实存在，并收集 `.icon--name` 映射。
    //
    //  / E10：扫描集合从 `app.css` 单文件扩到 `styles/*.css`（排除 `ds/`——
    // 副本的内容纪律由 ③ 的 sha256 等价保证，不归本仓令牌纪律管）。
    // **只增扫描面，不改判定正则**：扩容前后 `app.css` 的 findings 必须逐条一致。
    const appCssPath = join(root, WEB_DIR, 'styles', 'app.css')
    if (read(appCssPath) === undefined) {
      findings.push(`${WEB_DIR}/styles/app.css 不存在`)
    }
    const pageCssFiles = walk(root, [join(WEB_DIR, 'styles')], (name) => name.endsWith('.css')).filter(
      (file) => !relative(root, file).split('\\').join('/').includes('/styles/ds/'),
    )
    /** 图标类名 → 文件（供 ⑥ 的 JS 检查复用）。 */
    const iconTargets = new Map<string, string>()
    for (const cssPath of pageCssFiles) {
      const where = relative(root, cssPath).split('\\').join('/')
      const css = read(cssPath) ?? ''
      const lines = css.split('\n')
      lines.forEach((line, index) => {
        // 允许注释里出现示例；只查声明值
        if (/^\s*(\/\*|\*)/.test(line)) return
        if (/#[0-9a-fA-F]{3,8}\b/.test(line)) {
          findings.push(`${where}:${String(index + 1)} 出现裸色值（请用 var(--…) 令牌）`)
        }
      })
      // 图标路径必须真实存在（防止改名后静默 404）。相对**消费它的那份 CSS** 解析（00 §5.7）。
      for (const match of css.matchAll(/--icon-url:\s*url\(['"]?([^'")]+)['"]?\)/g)) {
        const urlPath = match[1] ?? ''
        if (isRemote(urlPath)) {
          findings.push(`${where}: 图标来自远程 ${urlPath}`)
          continue
        }
        const target = join(root, WEB_DIR, 'styles', urlPath)
        if (!existsSync(target)) findings.push(`${where}: 图标不存在 ${urlPath}`)
      }
      // `.icon--name { --icon-url: url(...) }` → 供 ⑥ 的 JS 检查复用（大小写映射在 CSS 里）
      for (const match of css.matchAll(
        /\.icon--([\w-]+)\s*\{[^}]*?--icon-url:\s*url\(['"]?([^'")]+)['"]?\)/g,
      )) {
        iconTargets.set(match[1] ?? '', match[2] ?? '')
      }
    }
    notes.push(`④ 令牌纪律扫描 ${String(pageCssFiles.length)} 个页面局部 css`)

    // ④b `hidden` 兜底：DS 组件给 `.ds-backdrop` 显式设了 display，用 hidden 表达的节点
    //    （凭证闸、审计面板、坐席骨架）会常驻可。2026-10-29 走查的 P0-1/P0-2 都源于此，
    //    这一条是它们的回归判据：改样式表时删掉兜底规则会立刻变红。
    if (!/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(read(appCssPath) ?? '')) {
      findings.push(`${WEB_DIR}/styles/app.css: 缺少 [hidden] { display: none !important } 兜底规则`)
    }

    // ④c 顶部横幅是可选节点（0–2 条）：`.app-shell` 的纵向排布不能依赖"子节点数固定"。
    //     2026-10-30 走查：`grid-template-rows: auto auto minmax(0,1fr)` 在两条横幅都 hidden 时，
    //     app-body 落进第二行 auto，底行 1fr 整块空着（1266×798 实测空 339px）。
    const shellRule = /\.app-shell\s*\{[^}]*\}/.exec(read(appCssPath) ?? '')?.[0] ?? ''
    if (!/display:\s*flex/.test(shellRule) || !/flex-direction:\s*column/.test(shellRule)) {
      findings.push(
        `${WEB_DIR}/styles/app.css: .app-shell 必须是 flex 纵向列（横幅 0–2 条可变，固定行数的 grid 会让主体挤进 auto 行、底部留白）`,
      )
    }

    // ⑤ 入口页清单：apps/web 下每个 .html 都必须挂齐**该壳**的样式与一个模块入口，
    //    且入口文件真实存在（不能靠"index.html 一把梭"漏检 operator.html / m.html）。
    const htmlFiles = files.filter((file) => file.endsWith('.html'))
    for (const file of htmlFiles) {
      const where = relative(root, file).split('\\').join('/')
      const name = where.slice(where.lastIndexOf('/') + 1)
      const html = read(file) ?? ''
      const required = REQUIRED_STYLES[name]
      if (required === undefined) {
        // 未登记入口：仍按通用规则查一遍（ds 两份 + 至少一份页面局部 CSS），并判红要求登记
        findings.push(
          `${where}: 未登记的入口页（请在 scripts/verify-web.ts 的 REQUIRED_STYLES 里声明必需样式）`,
        )
        for (const style of DS_STYLES) {
          if (!html.includes(style)) findings.push(`${where}: 缺少 ${style}`)
        }
        if (!/\.\/styles\/[^"']+\.css/.test(html)) findings.push(`${where}: 未挂任何页面局部 CSS`)
      } else {
        for (const style of required) {
          if (!html.includes(style)) findings.push(`${where}: 缺少 ${style}`)
        }
      }
      const entry = /<script[^>]*type=["']module["'][^>]*src=["'](\.\/src\/[^"']+\.js)["']/i.exec(html)
      if (entry === null) {
        findings.push(`${where}: 缺少 <script type="module" src="./src/**.js"> 模块入口`)
      } else if (!existsSync(join(root, WEB_DIR, entry[1] ?? ''))) {
        findings.push(`${where}: 入口文件不存在 ${entry[1] ?? ''}`)
      }
    }
    if (!htmlFiles.some((file) => file.endsWith('index.html'))) {
      findings.push(`${WEB_DIR}/index.html 不存在`)
    }

    // ⑥ JS 里 `icon('name')` 的实参必须在 CSS 里有 `.icon--name` 且文件存在。
    //    为什么查 CSS 映射而不是直接拼 `<name>.svg`：文件名大小写与 `user → UserCheck.svg`
    //    的映射都在 CSS 里，直接拼会在 Linux 上假红、在 Windows 上假绿。
    const jsFiles = files.filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
    for (const file of jsFiles) {
      const where = relative(root, file).split('\\').join('/')
      const source = read(file) ?? ''
      for (const match of source.matchAll(/\bicon\(\s*['"]([\w-]+)['"]/g)) {
        const name = match[1] ?? ''
        if (!iconTargets.has(name)) {
          findings.push(`${where}: icon('${name}') 没有对应的 .icon--${name} 样式/图标`)
        }
      }
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
