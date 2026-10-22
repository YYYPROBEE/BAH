/**
 * 门禁：Web 前端的四条硬约束（施工单 13 §6「grep 无 vue/react/组件库依赖」的工程化版本）。
 *
 * 1. **纯原生**：`apps/web` 不得依赖框架 / UI 组件库（在 `package.json` 与源码 import 两处查）；
 * 2. **零远程资源**：`src` / `href` / `url()` 里不得出现 `http(s)://`（离线演示、供应链最小面）；
 * 3. **令牌同步**：`apps/web/styles/ds/*.css` 必须与 `design/bah-ds/*.css` 逐字节一致；
 * 4. **令牌纪律**：`app.css` 不得出现裸色值（十六进制），只能用 `var(--…)`。
 *
 * 为什么第 3 条必须门禁：`design/bah-ds` 是自研视觉基线的唯一定义处，`styles/ds` 是它的分发副本。
 * 没有这条，半年后没人说得清页面上的圆角到底是哪一版令牌。
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

    // ④ 令牌纪律：app.css 不得出现裸色值
    const appCssPath = join(root, WEB_DIR, 'styles', 'app.css')
    const appCss = read(appCssPath)
    if (appCss === undefined) {
      findings.push(`${WEB_DIR}/styles/app.css 不存在`)
    } else {
      const lines = appCss.split('\n')
      lines.forEach((line, index) => {
        // 允许注释里出现示例；只查声明值
        if (/^\s*(\/\*|\*)/.test(line)) return
        if (/#[0-9a-fA-F]{3,8}\b/.test(line)) {
          findings.push(`${WEB_DIR}/styles/app.css:${String(index + 1)} 出现裸色值（请用 var(--…) 令牌）`)
        }
      })

      // 图标路径必须真实存在（防止改名后静默 404）
      for (const match of appCss.matchAll(/--icon-url:\s*url\(['"]?([^'")]+)['"]?\)/g)) {
        const urlPath = match[1] ?? ''
        if (isRemote(urlPath)) {
          findings.push(`${WEB_DIR}/styles/app.css: 图标来自远程 ${urlPath}`)
          continue
        }
        const target = join(root, WEB_DIR, 'styles', urlPath)
        if (!existsSync(target)) findings.push(`${WEB_DIR}/styles/app.css: 图标不存在 ${urlPath}`)
      }
    }

    // ⑤ index.html 必须挂本地样式与入口
    const indexHtml = read(join(root, WEB_DIR, 'index.html'))
    if (indexHtml === undefined) {
      findings.push(`${WEB_DIR}/index.html 不存在`)
    } else {
      for (const required of ['./styles/ds/colors_and_type.css', './styles/ds/components.css', './styles/app.css', './src/main.js']) {
        if (!indexHtml.includes(required)) findings.push(`${WEB_DIR}/index.html: 缺少 ${required}`)
      }
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
