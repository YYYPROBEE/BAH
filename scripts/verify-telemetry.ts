/**
 * 门禁：遥测内核的七条硬约束（可观测性 01 §6）。
 *
 * 为什么需要它：遥测最典型的坏法不是"崩"，是**静默失真**——
 * 加一个 `Date.now()`（快照回放漂到"今天"）、加一个 `readFileSync`（导出器不再是纯函数）、
 * 把工具名拼进 span 名（图例随工具增长）、引一个 `@opentelemetry/*`（R-2 破面）。
 * 这些代码都编译得过、测试也都绿，只有门禁能拦住。
 *
 * 七条判据（每条都配一个"怎么让它红"的反例，改这条门禁前先跑反例）：
 *
 * | # | 判据 | 反例 |
 * |---|---|---|
 * | 1 | 名字闭集恰好 13 个、无重复、每个都有发射点 | 加一个 `'foo'` |
 * | 2 | 包内源码无 `Date.now(` / `Math.random(` / `new Date(` | 插一行 `Date.now()` |
 * | 3 | 包内源码无 `node:fs` 导入（导出器必须是纯函数） | 加 `readFileSync` |
 * | 4 | `dependencies` 只含 `@bah/util` | 加 `openai` |
 * | 5 | 所有字面量 span 名都在闭集内 | 写 `withSpan('tool.execute.x')` |
 * | 6 | `derive.test.ts` 的 8 个场景都在 | 删掉一个 describe |
 * | 7 | Chrome 导出是**裸数组**且每项带 `ph` | 包成 `{traceEvents: []}` |
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

const PKG_DIR = join('packages', 'telemetry')
const PKG_SRC = join(PKG_DIR, 'src')

/** 扫描整个 `packages/`：包裹点在 host，派生在 telemetry，两边都要查。 */
const ALL_PACKAGES = 'packages'

/**
 * 已登记但**尚未接线**的名字。
 *
 * `policy.evaluate` 的发射点在 02（它和"判决计数"在同一处接线，一起改更好审）。
 * **02 收口时必须把这个数组清空**——留着它，等于允许往闭集里加永不发射的名字，
 * 那正是把"每个名字都被用到"这条判据稀释成"看起来有 13 个"的做法。
 */
const PENDING_EMITTER: readonly string[] = []

/** 无副作用的读（失败返回 `undefined`，由调用方决定算不算红）。 */
function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 只扫包内源码，**排除测试**（测试里有 `Date.now` 的假数据与 `node:fs` 的读取）。 */
const isPackageSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.test.ts') && !fileName.endsWith('.d.ts')

/** 从 `SPAN_NAMES` 源码里抠出全部条目（AST 太重，这里只需要字面量）。 */
function parseSpanNames(source: string): string[] {
  const match = /export const SPAN_NAMES = \[([\s\S]*?)\] as const/.exec(source)
  if (match === null) return []
  return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((item) => item[1] ?? '')
}

/** 调用形态：`x.open('…')` / `open('…')` / `openSpan('…')` 都算（派生器用的是裸调用）。 */
const CALL_PREFIX = '(?:\\.|(?<![\\w.]))'
const CALL_NAMES = '(?:withSpan|withSpanAsync|open|openSpan)'

/** 抠出 `withSpan('x')` / `open('x')` / `openSpan('x')` 的字面量名字。 */
function literalsOf(source: string): string[] {
  const found: string[] = []
  const pattern = new RegExp(`${CALL_PREFIX}${CALL_NAMES}\\(\\s*'([^']+)'`, 'g')
  for (const match of source.matchAll(pattern)) found.push(match[1] ?? '')
  return found
}

/**
 * 去掉注释再做文本判定。
 *
 * 必须去：本仓的注释里**故意**写着反例（"禁用 `Date.now()`"、"不要包 `{traceEvents: []}`"），
 * 不剥注释的话，门禁会把"写着纪律的那句话"当成"违反纪律"——一个只会误报的门禁，
 * 第二次就会被人加白名单绕过。
 *
 * 为什么不用 `/\*[\s\S]*?\*\//`：注释里会写 `plan/*` 这类路径通配（`/*` 后紧跟内容），
 * 一条正则会把从那里到下一个 `*​/` 之间的**代码整段吃掉**——实测吞掉了 `plan.run` 的发射点，
 * 门禁于是报"没有发射点"。所以按行扫、带块注释状态机。
 */
function stripComments(source: string): string {
  const out: string[] = []
  let inBlock = false
  for (const line of source.split('\n')) {
    let kept = ''
    let index = 0
    while (index < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', index)
        if (end === -1) {
          index = line.length
          break
        }
        inBlock = false
        index = end + 2
        continue
      }
      const block = line.indexOf('/*', index)
      const single = line.indexOf('//', index)
      // `://` 是 URL，不是注释
      const isUrl = single > 0 && line[single - 1] === ':'
      if (single !== -1 && !isUrl && (block === -1 || single < block)) {
        kept += line.slice(index, single)
        break
      }
      if (block !== -1) {
        kept += line.slice(index, block)
        inBlock = true
        index = block + 2
        continue
      }
      kept += line.slice(index)
      break
    }
    out.push(kept)
  }
  return out.join('\n')
}

const gate: Gate = {
  name: 'telemetry',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    // ① 名字闭集
    const spanSource = read(join(root, PKG_SRC, 'span.ts'))
    if (spanSource === undefined) {
      findings.push(`${PKG_SRC}/span.ts 不存在（名字闭集的唯一定义处丢失）`)
      return { ok: false, findings, notes }
    }
    const names = parseSpanNames(spanSource)
    if (names.length !== 13) findings.push(`${PKG_SRC}/span.ts: SPAN_NAMES 应是 13 个，实测 ${String(names.length)}`)
    const duplicated = names.filter((name, index) => names.indexOf(name) !== index)
    if (duplicated.length > 0) findings.push(`${PKG_SRC}/span.ts: SPAN_NAMES 有重复项 ${duplicated.join(',')}`)
    notes.push(`span 名 ${String(names.length)} 个`)

    // ②③ 确定性与纯度：包内源码不许有钟、随机、磁盘
    const pkgFiles = walk(root, [PKG_SRC], isPackageSource)
    const BANNED_IMPURE = [
      { pattern: /Date\.now\(/g, why: 'Date.now()（注入 now，否则快照回放会漂到"今天"）' },
      { pattern: /Math\.random\(/g, why: 'Math.random()（快照式断言会时绿时红）' },
      { pattern: /new Date\(/g, why: 'new Date()（同上）' },
    ]
    for (const file of pkgFiles) {
      const where = relative(root, file).split('\\').join('/')
      const text = stripComments(read(file) ?? '')
      for (const rule of BANNED_IMPURE) {
        const count = [...text.matchAll(rule.pattern)].length
        if (count > 0) findings.push(`${where}: 出现 ${rule.why}（${String(count)} 处）`)
      }
      if (/from\s+'node:(fs|fs\/promises)'/.test(text) || /require\('node:(fs|fs\/promises)'\)/.test(text)) {
        findings.push(`${where}: 引入了 node:fs（导出器必须是纯函数，不许读磁盘）`)
      }
    }
    notes.push(`已扫描 ${String(pkgFiles.length)} 个包内源码文件`)

    // ④ 零运行时依赖
    const pkgRaw = read(join(root, PKG_DIR, 'package.json'))
    if (pkgRaw === undefined) {
      findings.push(`${PKG_DIR}/package.json 不存在`)
    } else {
      const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string> }
      const deps = Object.keys(pkg.dependencies ?? {})
      const extra = deps.filter((name) => name !== '@bah/util')
      if (extra.length > 0) findings.push(`${PKG_DIR}/package.json: dependencies 只许有 @bah/util，多出 ${extra.join(',')}`)
      if (!deps.includes('@bah/util')) findings.push(`${PKG_DIR}/package.json: dependencies 缺 @bah/util`)
    }

    // ⑤ 所有字面量 span 名都在闭集内（跨包扫：包裹点在 host）
    const allFiles = walk(root, [ALL_PACKAGES], isPackageSource)
    const emitters = new Set<string>()
    let dynamicNames = 0
    for (const file of allFiles) {
      const where = relative(root, file).split('\\').join('/')
      const text = stripComments(read(file) ?? '')
      for (const literal of literalsOf(text)) {
        emitters.add(literal)
        if (!names.includes(literal)) {
          findings.push(`${where}: span 名 '${literal}' 不在闭集内（工具名要进 attributes，不要拼进名字）`)
        }
      }
      // 动态名字（变量入参）：静态查不了，只在 notes 里报数量，避免"看起来都查过了"
      const dynamic = new RegExp(`${CALL_PREFIX}${CALL_NAMES}\\(\\s*[^')\\s]`, 'g')
      dynamicNames += [...text.matchAll(dynamic)].length
    }
    notes.push(`发射点覆盖 ${String(emitters.size)} 个名字，动态名 ${String(dynamicNames)} 处`)

    // ①-b 每个名字都必须有发射点（闭集里不许留永不发射的名字）
    for (const name of names) {
      if (emitters.has(name)) continue
      if (PENDING_EMITTER.includes(name)) {
        notes.push(`待接线：${name}（02 收口时清空 PENDING_EMITTER）`)
        continue
      }
      findings.push(`${PKG_SRC}/span.ts: '${name}' 没有任何发射点（闭集里不许留永不发射的合法名字）`)
    }

    // ⑥ 派生场景用例齐全
    const deriveTest = read(join(root, PKG_SRC, 'derive.test.ts'))
    if (deriveTest === undefined) {
      findings.push(`${PKG_SRC}/derive.test.ts 不存在（派生器没有场景用例）`)
    } else {
      for (let index = 1; index <= 8; index += 1) {
        if (!deriveTest.includes(`场景 ${String(index)}`)) {
          findings.push(`${PKG_SRC}/derive.test.ts: 缺少"场景 ${String(index)}"（配对表的一条不变量没人守）`)
        }
      }
    }

    // ⑦ Chrome 导出必须是裸数组
    const chrome = read(join(root, PKG_SRC, 'export-chrome.ts'))
    if (chrome === undefined) {
      findings.push(`${PKG_SRC}/export-chrome.ts 不存在`)
    } else {
      const text = stripComments(chrome)
      if (!/JSON\.stringify\(events\)/.test(text)) {
        findings.push(`${PKG_SRC}/export-chrome.ts: 必须直接序列化 events 数组（包一层对象 Perfetto 会打不开）`)
      }
      if (/traceEvents/.test(text)) {
        findings.push(`${PKG_SRC}/export-chrome.ts: 出现 traceEvents 包裹（Perfetto 要求裸数组）`)
      }
      for (const phase of ["'X'", "'B'", "'M'"]) {
        if (!text.includes(`ph: ${phase}`)) {
          findings.push(`${PKG_SRC}/export-chrome.ts: 缺少 ph: ${phase}（闭合 / 未闭合 / 元数据）`)
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
