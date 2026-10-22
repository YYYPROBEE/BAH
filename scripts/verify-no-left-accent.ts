/**
 * 门禁：禁止用「最左边一条竖色带」表达状态或层级（视觉口径，2026-10-23）。
 *
 * 起因：工具卡三态曾用 `border-left-width: 3px` + `border-left-color: var(--status-*)` 画左侧状态条。
 * 该写法已按视觉口径否决，标准落在 `design/bah-ds/SKILL.md`「Component Usage Rules」与
 * `docs/web-frontend.md` §2.2 第 11 条；本门禁负责**强制**——只写文档的规则会在下次顺手改样式时复活，
 * 而复活路径通常正是下面几种规避写法，所以一并堵掉。
 *
 * 判定（命中任一即违规，逐条带 文件:行号）：
 * 1. 左/起始侧边框宽度 ≥3px —— `border-left-width` / `border-inline-start-width` / 简写里的 px 值；
 * 2. 左/起始侧边框取语义状态色或品牌色 —— 值里出现 `var(--status-` 或 `var(--bg-brand`。
 *    状态色的**整圈** `border-color` 允许（`.ds-notif--*` 就是这么做的），禁的只有单侧；
 * 3. 伪元素贴左边缘画色条 —— 选择器含 `::before`/`::after`，体内 `left: 0`（或 `inset-inline-start: 0`）
 *    + `width` ≤8px + `background` 取状态色/品牌色；
 * 4. 内阴影仿色条 —— `box-shadow: inset <≥3px> 0 …`。
 *
 * 刻意不算违规：1px 中性分隔线（`--border-neutral-*`）、`.ds-check` 的 2px 对勾笔画
 * （`border-left` + `border-bottom` + `rotate(-45deg)`，颜色 `--text-onbrand`）。
 * 阈值取"≥3px"与"状态/品牌色"两条并列，正是为了既放过笔画与分隔线、又抓住色条本尊。
 *
 * 扫描面：`apps/**` 的 css 与 js/ts（交付面）+ `design/bah-ds/*.css`（基线契约）。
 * `design/bah-ds/preview`、`ui_kits` 是展示证据、不是页面模板（SKILL.md「Required Consumption Order」），
 * 不入扫描面；里面的 2px 中性选中指示条属展示页惯例，不代表交付面可以照抄。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 一条 `属性: 值` 声明及其所在行（1 起）。 */
interface Declaration {
  readonly property: string
  readonly value: string
  readonly line: number
}

/** 一条叶子规则：选择器、规则体、体内第一条声明的字符下标。 */
interface Rule {
  readonly selector: string
  readonly body: string
  readonly bodyStart: number
}

/** 下标 → 1 起行号。 */
type LineAt = (index: number) => number

/** 状态色 / 品牌色令牌。 */
const ACCENT_COLOR = /var\(\s*--(?:status-|bg-brand)/

/** 左侧（含逻辑起始侧）边框属性。 */
const LEFT_BORDER = /^border-(?:left|inline-start)(?:-width|-color)?$/

/** 视为色条的最小宽度。 */
const STRIPE_MIN_PX = 3

/** 伪元素色条的最大宽度（超过它是块状背景，不是"条"）。 */
const STRIPE_MAX_PX = 8

const gate: Gate = {
  name: 'no-left-accent',

  async run(root): Promise<GateResult> {
    const cssFiles = walk(root, ['apps', 'design/bah-ds'], (name) => name.endsWith('.css'))
    const scriptFiles = walk(root, ['apps'], (name) => /\.(?:js|ts)$/.test(name))

    if (cssFiles.length === 0) {
      return {
        ok: false,
        findings: ['扫描面为空：apps/ 下一个 .css 都没找到 —— "没扫到"不能当"通过"'],
        notes: [],
      }
    }

    const findings: string[] = []
    for (const file of cssFiles) {
      const text = readFileSync(file, 'utf8')
      const where = relative(root, file).replace(/\\/g, '/')
      for (const hit of scanCss(text)) findings.push(`${where}:${String(hit.line)} ${hit.reason}`)
    }
    for (const file of scriptFiles) {
      const text = readFileSync(file, 'utf8')
      const where = relative(root, file).replace(/\\/g, '/')
      for (const hit of scanScript(text)) findings.push(`${where}:${String(hit.line)} ${hit.reason}`)
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `扫描 ${String(cssFiles.length)} 个 css + ${String(scriptFiles.length)} 个 js/ts（apps/ 与 design/bah-ds 基线）`,
        '豁免：1px 中性分隔线、非状态/非品牌色的 ≤2px 笔画（如 .ds-check 对勾）',
      ],
    }
  },
}

export { gate }

/* ────────────────────────────── css */

/** css 文本 → 违规列表。 */
function scanCss(text: string): Finding[] {
  const findings: Finding[] = []
  const lineAt = makeLineAt(text)
  for (const rule of cssRules(text)) {
    const stripePseudo = isLeftStripePseudo(rule)
    for (const decl of cssDeclarations(rule, lineAt)) {
      if (stripePseudo && /^background(?:-color)?$/.test(decl.property) && ACCENT_COLOR.test(decl.value)) {
        findings.push({
          line: decl.line,
          reason: `伪元素左侧色条：${rule.selector} 贴左边缘画了 ${decl.value}（状态请用 .ds-tag + 图标着色）`,
        })
        continue
      }
      const reason = judge(decl)
      if (reason !== undefined) findings.push({ line: decl.line, reason })
    }
  }
  return dedupe(findings)
}

/** 该规则是否是"贴左边缘的窄色条"伪元素：`::before`/`::after` + `left: 0` + `width` ≤8px。 */
function isLeftStripePseudo(rule: Rule): boolean {
  if (!/::(?:before|after)/.test(rule.selector)) return false
  if (!/(^|[;{\s])(?:left|inset-inline-start)\s*:\s*0(?:px)?\b/.test(rule.body)) return false
  const width = /(?:^|[;{\s])width\s*:\s*(\d+(?:\.\d+)?)px/.exec(rule.body)
  if (width === null || width[1] === undefined) return false
  return Number.parseFloat(width[1]) <= STRIPE_MAX_PX
}

/** 单条声明的判决；合规返回 `undefined`。 */
function judge(decl: Declaration): string | undefined {
  if (LEFT_BORDER.test(decl.property)) {
    const px = firstPx(decl.value)
    if (px !== undefined && px >= STRIPE_MIN_PX) {
      return `左侧色条：${decl.property}: ${decl.value}（左/起始侧边框 ≥${String(STRIPE_MIN_PX)}px）`
    }
    if (decl.property.endsWith('-color')) {
      return ACCENT_COLOR.test(decl.value)
        ? `左侧状态色条：${decl.property}: ${decl.value}（单侧取状态/品牌色；整圈 border-color 才允许）`
        : undefined
    }
    return ACCENT_COLOR.test(decl.value)
      ? `左侧状态色条：${decl.property}: ${decl.value}（单侧取状态/品牌色；整圈 border-color 才允许）`
      : undefined
  }

  if (decl.property === 'box-shadow') {
    const inset = /inset\s+(\d+(?:\.\d+)?)px\s+0(?:px)?\b|(\d+(?:\.\d+)?)px\s+0(?:px)?\s+inset/.exec(decl.value)
    const px = Number.parseFloat(inset?.[1] ?? inset?.[2] ?? '0')
    if (inset !== null && px >= STRIPE_MIN_PX) {
      return `内阴影仿左侧色条：box-shadow: ${decl.value}`
    }
  }

  return undefined
}

/** 叶子规则序列。`@media` 外层体内含 `{`，故天然不匹配 `[^{}]*`，只会被拆出内层规则。 */
function cssRules(text: string): Rule[] {
  const rules: Rule[] = []
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const raw = match[1] ?? ''
    rules.push({
      selector: raw.trim(),
      body: match[2] ?? '',
      bodyStart: (match.index ?? 0) + raw.length + 1,
    })
  }
  return rules
}

/** 规则体 → 声明序列（按 `;` 切，行号按字符下标还原）。 */
function* cssDeclarations(rule: Rule, lineAt: LineAt): Generator<Declaration> {
  let offset = 0
  for (const chunk of rule.body.split(';')) {
    const pair = /^\s*([-\w]+)\s*:\s*(.+)$/.exec(chunk)
    if (pair !== null) {
      yield {
        property: pair[1] ?? '',
        value: (pair[2] ?? '').trim(),
        line: lineAt(rule.bodyStart + offset),
      }
    }
    offset += chunk.length + 1
  }
}

/* ────────────────────────────── js / ts */

/** js/ts 里的内联样式与模板串（`style="border-left: …"`、`` css`border-left: …` ``）。 */
function scanScript(text: string): Finding[] {
  const findings: Finding[] = []
  const lineAt = makeLineAt(text)
  const pattern = /\b(border-(?:left|inline-start)(?:-width|-color)?|box-shadow)\s*[:=]\s*([^;"'`\n]+)/g
  for (const match of text.matchAll(pattern)) {
    const decl: Declaration = {
      property: (match[1] ?? '').trim(),
      value: (match[2] ?? '').trim(),
      line: lineAt(match.index ?? 0),
    }
    const reason = judge(decl)
    if (reason !== undefined) findings.push({ line: decl.line, reason })
  }
  return dedupe(findings)
}

/* ────────────────────────────── 小工具 */

interface Finding {
  readonly line: number
  readonly reason: string
}

/** 预换行位置，供整份文件反复求行号（避免逐声明重扫全文）。 */
function makeLineAt(text: string): LineAt {
  const breaks: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') breaks.push(i)
  }
  return (index: number): number => {
    let low = 0
    let high = breaks.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((breaks[mid] ?? 0) < index) low = mid + 1
      else high = mid
    }
    return low + 1
  }
}

/** 值里第一个 px 数值。 */
function firstPx(value: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)px/.exec(value)
  return match === null || match[1] === undefined ? undefined : Number.parseFloat(match[1])
}

/** 同一行的同一判决只报一次（简写与展开属性可能双双命中）。 */
function dedupe(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = `${String(f.line)}|${f.reason}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
