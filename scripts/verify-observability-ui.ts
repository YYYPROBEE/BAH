/**
 * 门禁：观测面板的界面契约（可观测性 03 §6.1，第 N+3 道）。
 *
 * 七条判据，每条都能用一个反例打红：
 * 1. `observe.js` 纯渲染：无 `fetch(` / `setTimeout(` / `setInterval(` / `Date.now(`；
 * 2. `createHttpApi` 至少含 `metrics` 与 `trace` 两个方法；
 * 3. `main.js` 有 `panel-observe` 容器，三个 tab 的 `aria-selected` 由同一循环同步；
 * 4. `app.css` 的 `.obs` 规则不含 `border-left` / `border-inline-start`（不许左侧色带）；
 * 5. 三个 CLI 子命令在 `parseCommand` 与 `run.ts` 的 switch 里**同时**出现；
 * 6. `docs/observability.md` 不含三句已成假话的旧口径；
 * 7. `metrics:begin/end` 标记存在且块内 ≥30 行指标名（防"删表了事"）。
 *
 * 判据 7 与 `verify-observability` 判据 1 有意重叠：一个守代码→文档，一个守文档→代码。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isMainModule, runStandalone, type Gate, type GateResult } from './gate-lib.ts'

const OBSERVE = 'apps/web/src/views/observe.js'
const TRANSPORT = 'apps/web/src/transport.js'
const MAIN = 'apps/web/src/main.js'
const CSS = 'apps/web/styles/app.css'
const COMMAND = 'packages/cli/src/cli/command.ts'
const RUN = 'packages/cli/src/cli/run.ts'
const DOC = 'docs/observability.md'

/** 旧口径（03 交付后这三句是假话）。 */
const STALE_CLAIMS = [/没有\s*trace\s*导出/, /无\s*trace\s*导出/, /没有成本看板/, /只覆盖\s*3\s*个出口/]

function read(root: string, file: string): string {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return ''
  }
}

/** 按 `}` 切 CSS 规则块（够用：本仓库的 app.css 没有嵌套规则）。 */
function cssRules(css: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = []
  let start = 0
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] !== '}') continue
    const chunk = css.slice(start, index)
    start = index + 1
    const brace = chunk.indexOf('{')
    if (brace < 0) continue
    rules.push({ selector: chunk.slice(0, brace).trim(), body: chunk.slice(brace + 1) })
  }
  return rules
}

const gate: Gate = {
  name: 'observability-ui',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    // ① 视图层纯渲染
    const observe = read(root, OBSERVE)
    if (observe === '') findings.push(`${OBSERVE}: 不存在（观测面板渲染层缺失）`)
    for (const pattern of [/\bfetch\s*\(/, /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\bDate\.now\s*\(/]) {
      if (pattern.test(observe)) findings.push(`${OBSERVE}: 出现 ${String(pattern)}（视图层必须是纯渲染）`)
    }

    // ② 传输层两个方法
    try {
      const module = (await import(pathToFileURL(join(root, TRANSPORT)).href)) as {
        createHttpApi?: (options: { token: string }) => Record<string, unknown>
      }
      const api = module.createHttpApi?.({ token: 'gate' })
      if (api === undefined) findings.push(`${TRANSPORT}: 未导出 createHttpApi`)
      else {
        for (const name of ['metrics', 'trace']) {
          if (typeof api[name] !== 'function') findings.push(`${TRANSPORT}: createHttpApi 缺方法 ${name}`)
        }
      }
    } catch (error) {
      findings.push(`${TRANSPORT}: 无法加载（${error instanceof Error ? error.message : String(error)}）`)
    }

    // ③ 第三 tab 与 aria 同步
    const main = read(root, MAIN)
    if (!main.includes("id: 'panel-observe'")) findings.push(`${MAIN}: 缺少 id 'panel-observe' 容器`)
    if (!main.includes("id: 'tab-observe'")) findings.push(`${MAIN}: 缺少 id 'tab-observe' 标签`)
    if (!/TAB_ORDER\s*=\s*\['dag',\s*'audit',\s*'observe'\]/.test(main)) {
      findings.push(`${MAIN}: TAB_ORDER 未包含三个 tab`)
    }
    if (!/for \(const name of TAB_ORDER\)[\s\S]*?aria-selected[\s\S]*?\n  \}/.test(main)) {
      findings.push(`${MAIN}: 三个 tab 的 aria-selected 未由同一循环同步`)
    }

    // ④ .obs 规则不许左侧色带
    const rules = cssRules(read(root, CSS)).filter((rule) => rule.selector.includes('.obs'))
    if (rules.length === 0) findings.push(`${CSS}: 找不到 .obs 规则（观测面板样式缺失）`)
    for (const rule of rules) {
      if (/border-left|border-inline-start/.test(rule.body)) {
        findings.push(`${CSS}: ${rule.selector} 出现左侧色带属性（U-3）`)
      }
    }
    notes.push(`app.css: .obs 规则 ${String(rules.length)} 条`)

    // ⑤ CLI 三命令同时出现在解析与分派
    const command = read(root, COMMAND)
    const run = read(root, RUN)
    for (const name of ['metrics', 'trace', 'cost']) {
      if (!command.includes(`case '${name}'`)) findings.push(`${COMMAND}: parseCommand 缺 ${name}`)
      const runner = `run${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
      if (!run.includes(`return ${runner}(`)) findings.push(`${RUN}: switch 缺 ${runner}(`)
    }

    // ⑥ 旧假话必须消失
    const doc = read(root, DOC)
    if (doc === '') findings.push(`${DOC}: 不存在`)
    for (const pattern of STALE_CLAIMS) {
      const hit = pattern.exec(doc)
      if (hit !== null) findings.push(`${DOC}: 仍保留过期口径「${hit[0]}」`)
    }

    // ⑦ 指标表仍在（≥30 行）
    const begin = doc.indexOf('<!-- metrics:begin -->')
    const end = doc.indexOf('<!-- metrics:end -->')
    if (begin < 0 || end <= begin) {
      findings.push(`${DOC}: 缺少 metrics:begin/end 标记`)
    } else {
      const block = doc.slice(begin, end)
      const rows = [...block.matchAll(/^\|\s*`bah_[a-z0-9_]+`/gm)].length
      if (rows < 30) findings.push(`${DOC}: 指标表只有 ${String(rows)} 行（≥30）`)
      notes.push(`docs/observability.md: 指标表 ${String(rows)} 行`)
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
