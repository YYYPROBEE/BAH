/**
 * 门禁：移动 H5 壳的专属不变量（施工单 00 D14 第 02 行 / 施工单 02 §6.1）。
 *
 * 与 `verify-web.ts` 的分工：那条管**全局**四条硬约束（无框架 / 零远程 / DS 副本 sha256 /
 * 令牌纪律）；本条管移动新增面——CSP 内联、第二份 transport|store、触控尺寸、安全区、
 * 图标逐字节分发、token 入口白名单、令牌名拼写。两者互补不重叠（唯一交集是 DS 副本 sha256，
 * 施工期误改的概率不低，值得查两遍）。
 *
 * **为什么不用禁用词清单**：禁用词（"不许 touch-only"之类）不可机械判定、随措辞漂移、
 * 假阳假阴都高。本门禁每条都是正则 / sha256 / fs 可判定的形态；语义级要求交测试与走查
 * （D11 三句话 = TC-MOB-15、blocked 显式 = TC-MOB-23、手势不替代 verify = TC-MOB-07）。
 * 把语义判定塞进正则门禁，正是"findings 塞进 notes 绕过"的温床。
 *
 * 十一条不变量（findings = 阻断，notes = 非阻断）：
 * I1 无框架/无 eval · I2 零远程资源 · I3 m.html 形态 · I4 无裸色值 · I4b theme-color 对齐令牌
 * I5 不自带第二份 transport/store · I6 DS 副本逐字节 · I7 触控 ≥44px · I8 安全区
 * I9 图标逐字节分发 + 尺寸集合 + 名字有映射 · I10 token 入口白名单
 * 另加 I11（R6）：mobile.css 引用的每个 `var(--…)` 必须有定义处——令牌名写错是
 * "静默失效、无色无报错"，只能靠机器查。
 * 另加 I12（2026-10-29 移动走查 P0-2）：mobile.css 必须有 `[hidden]` 兜底显隐——
 * DS 副本给遮罩等节点显式设了 display，会覆盖 UA 的 `[hidden]`，让"关着"的节点吞掉点击。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/**
 * 路径常量一律写**正斜杠相对路径**：既给 `join(root, …)` 用（Node 在 Windows 上照样解析），
 * 也直接进 findings 文本——用 `join()` 拼出来的常量在 Windows 上是反斜杠，
 * 排障时按门禁输出里的路径去搜会搜不到。
 */
const WEB = 'apps/web'
const MOBILE_SRC = 'apps/web/src/mobile'
const DESIGN = 'design/bah-ds'
const DESIGN_ICONS = 'design/bah-ds/assets/icons'
const M_HTML = 'apps/web/m.html'
const MOBILE_CSS = 'apps/web/styles/mobile.css'

/** 禁止的框架 / 组件库（与 verify-web 同一份口径）。 */
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
] as const

/** 裸色值：十六进制 / rgb() / hsl()。整行匹配 ⇒ `var(--x, #fff)` 的 fallback 形态天然覆盖（B1 探针）。 */
const BARE_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/

/** "第二份实现"的特征：定义而不是 import。 */
const SECOND_IMPL = [
  /fetch\s*\(/,
  /new\s+EventSource/,
  /function\s+createHttpApi/,
  /function\s+connectEvents/,
  /function\s+createStore/,
  /function\s+frameKey/,
] as const

/** 图标尺寸只许这三档（00 §5.7：12/20 存在但禁用）。 */
const ICON_SIZES = new Set(['14', '16', '24'])

/** 触控目标下限（00 §5.9）。 */
const TOUCH_MIN_PX = 44

/**
 * I7 的豁免清单：**空**。
 *
 * WHY 空：mobile.css 用一条 blanket 规则（`.m-shell button, .m-shell [role='button'], …`）
 * 把壳内所有可点元素一次性抬到 44×44，所以没有"这个类天生小"的例外需要登记。
 * 豁免清单一旦非空就成了后门（B5 探针：施工期往里塞类名躲 44px），
 * 加任何一条都必须带 WHY 注释并在复审里逐条质询。
 */
const TOUCH_EXEMPT: readonly string[] = []

/**
 * 运行期才赋值的 CSS 变量（I11 的例外，逐条带出处）。
 * 它们在 CSS 里只被 `var()` 读、不被声明，声明发生在 JS 的 CSSOM 写入里。
 */
const RUNTIME_VARS: Readonly<Record<string, string>> = {
  '--icon-size': 'dom.js icon(name,size) 用 Object.assign 写进节点 style',
  '--thumb-x': 'gesture-confirm.js paint() 写滑块位移',
  '--thumb-travel': 'gesture-confirm.js paint() 写键盘长按的目标位移',
}

/** I10：`bah-web-token` 只许出现在这些面上（相对路径前缀匹配）。 */
const TOKEN_WHITELIST = [
  'apps/web/src/transport.js',
  'apps/web/index.html',
  'apps/web/m.html',
  'packages/host/src/boot/plugins/',
  'docs/',
] as const

/** 读文件（失败返回 undefined）。 */
function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 统一成正斜杠相对路径（Windows 上 relative() 给反斜杠）。 */
function rel(root: string, file: string): string {
  return relative(root, file).split('\\').join('/')
}

/** 下标 → 1 起行号。 */
function lineAt(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text[cursor] === '\n') line += 1
  }
  return line
}

/**
 * 把 CSS 注释换成等长空白（保留行号与列号）。
 *
 * WHY 需要它：注释里写 `var(--…)` 这种示意写法是文档的一部分，不是 CSS；
 * 不剥注释就会把"讲解令牌纪律的那句话"判成"引用了未定义令牌"。
 * I4（裸色值）**刻意不剥**——那是更严的口径：连注释里都不许出现色值字面量，
 * 这样"在注释里留个原值方便以后抄回来"这条后门也一并堵掉。
 */
function blankCssComments(css: string): string {
  let out = ''
  let index = 0
  while (index < css.length) {
    if (css[index] === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      const stop = end === -1 ? css.length : end + 2
      for (let cursor = index; cursor < stop; cursor += 1) out += css[cursor] === '\n' ? '\n' : ' '
      index = stop
      continue
    }
    out += css[index] ?? ''
    index += 1
  }
  return out
}

/** 抽出所有 import / require 的说明符（框架判据打在这里，不打在裸文本上）。 */
function importSpecifiers(text: string): Array<{ specifier: string; index: number }> {
  const found: Array<{ specifier: string; index: number }> = []
  for (const pattern of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\bsrc\s*=\s*["']([^"']+)["']/gi]) {
    for (const match of text.matchAll(pattern)) {
      found.push({ specifier: match[1] ?? '', index: match.index ?? 0 })
    }
  }
  return found
}

/** 一条叶子规则。 */
interface CssRule {
  readonly selector: string
  readonly body: string
  readonly line: number
}

/**
 * 极简 CSS 规则解析（够本门禁用：不处理 @supports 嵌套里的注释怪写法）。
 *
 * at-rule 的块**透明化**（`@media` 里的规则照样收进来）：否则 reduced-motion 块里的声明
 * 就成了门禁盲区，而那块恰好是"动效降级"的判据面。
 */
function parseRules(css: string, baseOffset = 0, depth = 0): CssRule[] {
  const rules: CssRule[] = []
  let index = 0
  let selectorStart = 0

  while (index < css.length) {
    const char = css[index]
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2)
      index = end === -1 ? css.length : end + 2
      continue
    }
    if (char === '{') {
      const selector = css.slice(selectorStart, index).trim()
      let cursor = index + 1
      let nested = 1
      while (cursor < css.length && nested > 0) {
        if (css[cursor] === '{') nested += 1
        else if (css[cursor] === '}') nested -= 1
        cursor += 1
      }
      const body = css.slice(index + 1, cursor - 1)
      if (selector.startsWith('@')) {
        rules.push(...parseRules(body, baseOffset + index + 1, depth + 1))
      } else {
        rules.push({ selector, body, line: lineAt(css, selectorStart) })
      }
      index = cursor
      selectorStart = index
      continue
    }
    index += 1
  }
  return rules
}

/** 从规则体里取某个属性的所有 px 值。 */
function pxValues(body: string, property: string): number[] {
  const found: number[] = []
  for (const match of body.matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+)`, 'g'))) {
    const value = match[1] ?? ''
    for (const px of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      const parsed = Number.parseFloat(px[1] ?? '')
      if (Number.isFinite(parsed)) found.push(parsed)
    }
  }
  return found
}

/** 是否是"可交互选择器"。 */
function isInteractiveSelector(selector: string): boolean {
  return /button|\[role=['"]?button/i.test(selector)
}

const gate: Gate = {
  name: 'mobile-shell',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const mobileSources = walk(root, [MOBILE_SRC], (name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    const mHtmlPath = join(root, M_HTML)
    const mobileCssPath = join(root, MOBILE_CSS)
    const mHtml = read(mHtmlPath)
    const mobileCss = read(mobileCssPath)

    if (mHtml === undefined) findings.push(`I3 ${M_HTML} 不存在（移动壳没有静态入口）`)
    if (mobileCss === undefined) findings.push(`I4 ${MOBILE_CSS} 不存在（移动壳没有页面局部样式）`)
    if (mobileSources.length === 0) findings.push(`I1 ${MOBILE_SRC}/ 下没有生产源码（"没扫到"不能当"通过"）`)

    // ── I1 无框架 / 无 eval ────────────────────────────────────────────────
    // 框架判据打在 **import/src 说明符**上（与 verify-web ①② 同一手法），不打在裸文本上：
    // 裸文本匹配会把普通英文与 JS 词里的子串当成框架名（实测 `split` 里含 `lit`），
    // 一条天天假红的门禁下场是被人整条关掉——那比没有门禁更糟。
    const i1Targets = [...mobileSources, ...(mHtml === undefined ? [] : [mHtmlPath])]
    for (const file of i1Targets) {
      const text = read(file) ?? ''
      const where = rel(root, file)
      for (const { specifier, index } of importSpecifiers(text)) {
        const hit = FORBIDDEN.find((prefix) => specifier === prefix || specifier.startsWith(prefix))
        if (hit !== undefined) {
          findings.push(
            `I1 ${where}:${String(lineAt(text, index))} 引入了 '${specifier}'（纯原生约束，命中 ${hit}）`,
          )
        }
      }
      for (const pattern of [/eval\s*\(/, /new\s+Function\s*\(/]) {
        const match = pattern.exec(text)
        if (match !== null) {
          findings.push(
            `I1 ${where}:${String(lineAt(text, match.index))} 出现 ${match[0].trim()}（CSP 不含 unsafe-eval，且这是代码注入面）`,
          )
        }
      }
    }
    notes.push(`I1 框架判据打在 import/src 说明符上（裸文本匹配会被 'split' 里的 'lit' 之类假阳拖垮）`)

    // ── I2 零远程资源 ──────────────────────────────────────────────────────
    for (const file of i1Targets.concat(mobileCss === undefined ? [] : [mobileCssPath])) {
      const text = read(file) ?? ''
      const where = rel(root, file)
      for (const match of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)"']+)/gi)) {
        const url = (match[1] ?? match[2] ?? '').trim()
        // 协议相对（//host/x）也算远程：它跟着页面协议走，离线演示时直接失败
        if (/^https?:\/\//i.test(url) || url.startsWith('//')) {
          findings.push(`I2 ${where}: 引用了远程资源 ${url}（必须本地化）`)
        }
      }
    }

    // ── I3 m.html 形态：必备清单 + 零内联 ──────────────────────────────────
    if (mHtml !== undefined) {
      for (const required of [
        './styles/ds/colors_and_type.css',
        './styles/ds/components.css',
        './styles/mobile.css',
        './src/mobile/shell.js',
      ]) {
        if (!mHtml.includes(required)) findings.push(`I3 ${M_HTML}: 缺少 ${required}`)
      }
      if (mHtml.includes('./styles/app.css')) {
        findings.push(`I3 ${M_HTML}: 引了桌面壳的 app.css（双壳的页面局部样式各自独立，00 D1）`)
      }
      if (/<style/i.test(mHtml)) findings.push(`I3 ${M_HTML}: 出现 <style> 块（CSP style-src 'self' 会拒）`)
      for (const match of mHtml.matchAll(/\sstyle\s*=\s*["']/gi)) {
        findings.push(`I3 ${M_HTML}:${String(lineAt(mHtml, match.index))} 出现内联 style 属性（同上）`)
      }
      for (const match of mHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = match[1] ?? ''
        const body = match[2] ?? ''
        if (!/\bsrc\s*=/i.test(attrs)) {
          findings.push(`I3 ${M_HTML}:${String(lineAt(mHtml, match.index))} 出现无 src 的内联脚本`)
        }
        if (body.trim().length > 0) {
          findings.push(`I3 ${M_HTML}:${String(lineAt(mHtml, match.index))} <script> 体内有代码（CSP script-src 'self' 会拒）`)
        }
      }
    }

    // ── I4 / I4b 裸色值 与 theme-color 对齐令牌 ────────────────────────────
    const pageCssFiles = walk(root, [join(WEB, 'styles')], (name) => name.endsWith('.css'))
      .filter((file) => !file.split('\\').join('/').includes('/styles/ds/'))
    for (const file of pageCssFiles) {
      const text = read(file) ?? ''
      const where = rel(root, file)
      text.split('\n').forEach((line, index) => {
        if (BARE_COLOR.test(line)) {
          findings.push(`I4 ${where}:${String(index + 1)} 出现裸色值（只能用 var(--…) 令牌；含 fallback 形态）`)
        }
      })
    }

    const tokenSource = read(join(root, DESIGN, 'colors_and_type.css')) ?? ''
    const tokenMatch = /--bg-base-default\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(tokenSource)
    const themeMatch = mHtml === undefined ? null : /<meta\s+name="theme-color"\s+content="([^"]+)"/i.exec(mHtml)
    if (tokenMatch === null) {
      findings.push(`I4b ${DESIGN}/colors_and_type.css 里找不到 --bg-base-default（令牌基线变了，门禁判据需同步）`)
    } else if (themeMatch === null) {
      findings.push(`I4b ${M_HTML}: 缺 <meta name="theme-color">（移动浏览器 UI 融合靠它）`)
    } else if ((themeMatch[1] ?? '').toLowerCase() !== (tokenMatch[1] ?? '').toLowerCase()) {
      findings.push(
        `I4b ${M_HTML}: theme-color '${themeMatch[1]}' 与 DS 令牌 --bg-base-default '${tokenMatch[1]}' 不一致（HTML 里长出了裸色值飞地）`,
      )
    }

    // ── I5 不得自带第二份 transport / store ────────────────────────────────
    for (const file of mobileSources) {
      const text = read(file) ?? ''
      const where = rel(root, file)
      for (const pattern of SECOND_IMPL) {
        const match = pattern.exec(text)
        if (match !== null) {
          findings.push(
            `I5 ${where}:${String(lineAt(text, match.index))} 出现 '${match[0].trim()}'——共享层只有一份实现（00 D1，只许 import）`,
          )
        }
      }
    }

    // ── I6 DS 副本逐字节 ──────────────────────────────────────────────────
    for (const name of ['colors_and_type.css', 'components.css']) {
      const upstream = join(root, DESIGN, name)
      const copy = join(root, WEB, 'styles', 'ds', name)
      if (!existsSync(upstream)) findings.push(`I6 ${rel(root, upstream)} 缺失（令牌唯一定义处没了）`)
      else if (!existsSync(copy)) findings.push(`I6 ${rel(root, copy)} 缺失（分发副本没了）`)
      else if (sha256(upstream) !== sha256(copy)) {
        findings.push(`I6 ${rel(root, copy)} 与 ${rel(root, upstream)} 不一致（移动施工期误改了 DS 副本）`)
      }
    }

    // ── I7 触控目标 ≥44px ─────────────────────────────────────────────────
    const cssRules = mobileCss === undefined ? [] : parseRules(mobileCss)
    let blanketOk = false
    for (const rule of cssRules) {
      const interactive = isInteractiveSelector(rule.selector)
      for (const property of ['min-height', 'height']) {
        for (const value of pxValues(rule.body, property)) {
          if (!interactive) continue
          if (value >= TOUCH_MIN_PX) {
            if (property === 'min-height') blanketOk = true
            continue
          }
          const exempt = TOUCH_EXEMPT.some((name) => rule.selector.includes(name))
          if (exempt) {
            notes.push(`I7 豁免 ${rule.selector} 的 ${property}: ${String(value)}px（豁免清单必须逐条带 WHY）`)
            continue
          }
          findings.push(
            `I7 mobile.css:${String(rule.line)} ${rule.selector} 的 ${property} 是 ${String(value)}px，小于 ${String(TOUCH_MIN_PX)}px`,
          )
        }
      }
    }
    if (!blanketOk) {
      findings.push(
        `I7 mobile.css 里没有任何"可交互选择器 + min-height ≥${String(TOUCH_MIN_PX)}px"的规则（触控纪律没有落点）`,
      )
    }

    // ── I8 安全区 ─────────────────────────────────────────────────────────
    if (mobileCss !== undefined) {
      for (const edge of ['top', 'bottom']) {
        if (!mobileCss.includes(`env(safe-area-inset-${edge})`)) {
          findings.push(`I8 mobile.css 缺 env(safe-area-inset-${edge})（系统手势条会压住内容）`)
        }
      }
    }
    if (mHtml !== undefined && !/name="viewport"[^>]*viewport-fit=cover/i.test(mHtml)) {
      findings.push(`I8 ${M_HTML}: viewport 缺 viewport-fit=cover（env(safe-area-inset-*) 会恒为 0）`)
    }

    // ── I9 图标：逐字节分发 + 尺寸集合 + 名字有映射 ────────────────────────
    const iconUrls = new Set<string>()
    if (mobileCss !== undefined) {
      mobileCss.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/--icon-url\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
          const url = (match[1] ?? '').trim()
          const where = `mobile.css:${String(index + 1)}`
          if (!url.startsWith('../assets/icons/') || !url.endsWith('.svg')) {
            findings.push(`I9 ${where} 的图标路径 '${url}' 不在 ../assets/icons/*.svg 白名单内（不得越出 apps/web）`)
            continue
          }
          iconUrls.add(url.slice('../assets/icons/'.length))
          const local = resolve(join(root, WEB, 'styles'), url)
          if (!existsSync(local)) {
            findings.push(`I9 ${where} 的图标不存在：${url}`)
            continue
          }
          const upstream = join(root, DESIGN_ICONS, basename(url))
          if (!existsSync(upstream)) {
            findings.push(`I9 ${where} 的图标 ${basename(url)} 在 ${rel(root, DESIGN_ICONS)} 里没有同名字（不是逐字节分发）`)
          } else if (sha256(local) !== sha256(upstream)) {
            findings.push(`I9 ${where} 的图标 ${basename(url)} 与 design 侧同名文件 sha256 不一致（换皮了）`)
          }
        }
      })
    }

    /** mobile.css 里定义了映射的图标名（`.icon--<name>`）。 */
    const mappedNames = new Set<string>()
    if (mobileCss !== undefined) {
      for (const match of mobileCss.matchAll(/\.icon--([a-zA-Z0-9_-]+)/g)) mappedNames.add(match[1] ?? '')
    }
    for (const file of mobileSources) {
      const text = read(file) ?? ''
      const where = rel(root, file)
      for (const match of text.matchAll(/\bicon\(\s*'([a-zA-Z0-9_-]+)'\s*(?:,\s*(\d+))?\s*\)/g)) {
        const name = match[1] ?? ''
        const size = match[2]
        if (size !== undefined && !ICON_SIZES.has(size)) {
          findings.push(`I9 ${where}:${String(lineAt(text, match.index))} icon('${name}', ${size}) 的尺寸不在 {14,16,24} 里（00 §5.7）`)
        }
        if (!mappedNames.has(name)) {
          findings.push(`I9 ${where}:${String(lineAt(text, match.index))} icon('${name}') 在 mobile.css 里没有 .icon--${name} 映射（图标画不出来）`)
        }
      }
      // 字面量 class 形态（`class: 'icon icon--mic'`）同样要有映射
      for (const match of text.matchAll(/icon--([a-zA-Z0-9_-]+)/g)) {
        const name = match[1] ?? ''
        if (!mappedNames.has(name)) {
          findings.push(`I9 ${where}:${String(lineAt(text, match.index))} 用了 .icon--${name} 但 mobile.css 没有这条映射`)
        }
      }
    }
    notes.push(`I9 图标：mobile.css 引用 ${String(iconUrls.size)} 个，映射名 ${String(mappedNames.size)} 个`)

    // ── I10 token 入口白名单 ──────────────────────────────────────────────
    const tokenHits: string[] = []
    const placeholderHits: string[] = []
    for (const file of walk(root, ['apps', 'packages', 'scripts', 'docs', 'profiles', 'services'], (name) =>
      /\.(?:ts|tsx|js|mjs|cjs|html|md|yml|json)$/.test(name),
    )) {
      const where = rel(root, file)
      // 临时目录不是交付面（`.tmp-*` 里躺着历史演练的缓存，扫进来只会造假红）
      if (where.split('/').some((segment) => segment.startsWith('.'))) continue
      // 本门禁自己必须写出它在找什么串，否则判据无从表达；这一条自豁免只此一个路径。
      if (where === 'scripts/verify-mobile-shell.ts') continue
      const text = read(file) ?? ''
      if (text.includes('bah-web-token')) tokenHits.push(where)
      // 占位符只看**可执行/配置面**：`.md` 里引用"占位符不许用"这条不变量本身不是违规。
      // 占位符要生效只能经 HTML / JS / 配置，文档不构成注入面（写了也不会被服务端读）。
      if (!where.endsWith('.md') && text.includes('__BAH_WEB_TOKEN__')) placeholderHits.push(where)
    }
    for (const where of tokenHits) {
      const allowed =
        where.endsWith('.test.ts') ||
        where.endsWith('.test.js') ||
        TOKEN_WHITELIST.some((prefix) => where === prefix || where.startsWith(prefix))
      if (!allowed) findings.push(`I10 ${where} 出现了 'bah-web-token'（token 面只许在白名单里）`)
    }
    // 注入器是"先剥离同名 meta 再插入"，不用占位符 ⇒ 仓里出现占位符就是有人自己发明了一套注入
    for (const where of placeholderHits) {
      findings.push(`I10 ${where} 出现了 '__BAH_WEB_TOKEN__' 占位符（injectWebToken 不用占位符；写了就是假 token 字面量）`)
    }
    notes.push(`I10 token 面命中 ${String(tokenHits.length)} 个文件，占位符命中 ${String(placeholderHits.length)} 个`)

    // ── I11（R6）令牌名拼写：var(--x) 必须有定义处 ────────────────────────
    if (mobileCss !== undefined) {
      const defined = new Set<string>()
      for (const source of [tokenSource, read(join(root, DESIGN, 'components.css')) ?? '', mobileCss]) {
        for (const match of source.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(match[1] ?? '')
      }
      const missing = new Map<string, number>()
      const scannable = blankCssComments(mobileCss)
      scannable.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
          const name = match[1] ?? ''
          if (defined.has(name) || RUNTIME_VARS[name] !== undefined) continue
          if (!missing.has(name)) missing.set(name, index + 1)
        }
      })
      for (const [name, line] of missing) {
        findings.push(
          `I11 mobile.css:${String(line)} 引用了 var(${name})，但 DS 两份令牌文件与 mobile.css 里都没有它的定义（拼错会静默失效、无色无报错）`,
        )
      }
      notes.push(
        `I11 令牌：定义处 ${String(defined.size)} 个、未定义引用 ${String(missing.size)} 个；运行期变量例外 ${String(Object.keys(RUNTIME_VARS).length)} 个（逐条带出处）`,
      )
    }

    // ── I12 `hidden` 兜底显隐 ──────────────────────────────────────────────
    // 判据是"有没有一条 `[hidden]` + `display: none !important`"：只要这条在，
    // 遮罩/中断钮/空清单/折叠体都不会因为类上的 display 而常驻可见（P0-2 的一行修法）。
    // 不逐类检查"用 hidden 的节点其 class 不得设 display"——那是语义级要求，
    // 正则判不准（同一个 class 在别的状态下必须可见），交测试与走查。
    if (
      mobileCss !== undefined &&
      !/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(blankCssComments(mobileCss))
    ) {
      findings.push(
        `I12 ${MOBILE_CSS} 缺 [hidden] 兜底规则（DS 副本的 display 会覆盖 hidden 属性，关着的遮罩会吞掉全部点击）`,
      )
    }

    notes.push(`扫描面：mobile 生产源码 ${String(mobileSources.length)} 个文件、页面局部 css ${String(pageCssFiles.length)} 个`)
    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
