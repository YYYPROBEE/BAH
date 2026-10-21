/**
 * 门禁：视觉口径的自研不变量（NOTICE.md「BAH DS 自研设计系统」声明的工程化版本）。
 *
 * 为什么不做「禁用词清单」：清单要求把被禁字面量写进脚本，于是脚本自身永远成为
 * 一次命中（`verify-no-upstream-imports.ts` 就因此把 `scripts/` 排除在扫描面外）。
 * 本门禁改为正向断言——只认唯一合法的基线名与唯一合法的自称，任何别的取值即红，
 * 因此不需要存储任何被禁字面量，也不依赖 `grep -I` 那类会漏报二进制、误报词形的扫法。
 *
 * 复审记录（2026-10-21）：上一轮人工核查踩到三个判据陷阱，本门禁逐条堵掉：
 * ① 只扫文件内容、不扫文件名 → 漏；② `grep -I` 跳二进制 → 漏，不跳又误报 base64；
 * ③ 子串匹配把 `extra*` / `intra*` 系列驼峰标识符当命中（它们内部恰好含被追查字串的连续字母）→ 假警。
 * 所以这里只按「规范名的形态」判定，并且必须报告实际扫描到的文件数（见 fail-closed 那条）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 唯一合法的视觉基线目录名（基线路径与自称都由它推导）。 */
const BASELINE_DIR = 'bah-ds'

/** 唯一合法的自称（出现在 `X Design System` / `X 设计系统` 形态里时必须是它）。 */
const SELF_NAME = 'BAH DS'

/** 必须明示自研口径的锚点文件（改口径必须同步这里，否则红）。 */
const ANCHORS = [
  'NOTICE.md',
  'docs/web-frontend.md',
  'apps/web/index.html',
  'apps/web/styles/app.css',
] as const

/** 参与扫描的文本后缀（白名单，避免"二进制到底算不算命中"这类歧义）。 */
const TEXT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.svg',
  '.txt',
  '.yaml',
  '.yml',
]

/** 交付面子目录（刻意不含 `.workbuddy/` 之类工具日志：它不是交付物，也不该让 CI 为它红）。 */
const SCAN_DIRS = [
  'apps',
  'packages',
  'docs',
  'design',
  'scripts',
  'profiles',
  'snapshots',
  'services',
  'tests',
]

/** 根级单文件（PROGRESS.md 等施工记录也在口径范围内）。 */
const ROOT_FILES = ['NOTICE.md', 'PROGRESS.md', 'README.md', 'AGENTS.md', 'package.json']

/**
 * 「有资格给视觉系统命名」的文件面。R3 只在这里生效——
 * showcase 页面里的 "Our design system" / "Living design system" 是文案不是命名主张，
 * 全局套用会造出假警（复审时实测 10 条里 6 条是这类）。
 */
const NAMING_SURFACE = [
  'NOTICE.md',
  'PROGRESS.md',
  'docs/web-frontend.md',
  'docs/web-frontend-review.md',
  'apps/web/index.html',
  'apps/web/styles/app.css',
  'design/bah-ds/README.md',
  'design/bah-ds/SKILL.md',
  'design/bah-ds/library-consumption.json',
  'design/bah-ds/components/index.json',
] as const

/** fail-closed 下限：低于这个数说明扫描面塌了（路径写错 / walk 静默失败），不能算绿。 */
const MIN_SCANNED = 300

const isTextFile = (fileName: string): boolean =>
  TEXT_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext))

/** `design/<slug>` 形态的基线路径引用。 */
const BASELINE_PATH_PATTERN = /design\/([A-Za-z0-9][A-Za-z0-9._-]*)/g

/** `X Design System` / `X 设计系统` 形态的自称。 */
const SELF_NAME_PATTERN = /([A-Za-z0-9一-龥][A-Za-z0-9 .一-龥]{0,28}?)\s*(?:Design System|设计系统)/gi

const gate: Gate = {
  name: 'visual-line',

  async run(root) {
    const findings: string[] = []
    const notes: string[] = []

    // R1 基线目录必须唯一且名为 BASELINE_DIR
    const designRoot = resolve(root, 'design')
    const designDirs = existsSync(designRoot)
      ? readdirSync(designRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : []
    if (!existsSync(designRoot)) {
      findings.push(`design/: 基线目录不存在（唯一定义处应为 design/${BASELINE_DIR}）`)
    } else if (designDirs.length !== 1 || designDirs[0] !== BASELINE_DIR) {
      findings.push(
        `design/: 基线目录必须恰好一个且名为 ${BASELINE_DIR}，实测 ${formatList(designDirs)}`,
      )
    }
    notes.push(`design/ 实测目录：${formatList(designDirs)}`)

    // R2–R4 逐文件扫描
    const files = collectFiles(root)
    if (files.length < MIN_SCANNED) {
      findings.push(
        `扫描面仅 ${String(files.length)} 个文本文件（下限 ${String(MIN_SCANNED)}）——` +
          '判据失效即视为不通过，禁止"没扫到"当"绿"',
      )
    }
    notes.push(`已扫描 ${String(files.length)} 个文本文件（${SCAN_DIRS.join(', ')} + 根级 ${String(ROOT_FILES.length)} 个）`)

    let pathRefs = 0
    for (const file of files) {
      const rel = relative(root, file)
      const text = safeRead(file)
      if (text === undefined) {
        findings.push(`${rel}: 无法读取（权限或编码问题）`)
        continue
      }
      // 文件名也要进判据：上一轮就是只扫内容漏了文件名
      const lines = `${rel}\n${text}`.split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(BASELINE_PATH_PATTERN)) {
          const slug = match[1]
          if (slug === undefined) continue
          pathRefs += 1
          if (slug !== BASELINE_DIR) {
            findings.push(
              `${rel}:${index + 1} [baseline-path] 基线路径只能是 design/${BASELINE_DIR}，此处为 ${match[0]}`,
            )
          }
        }
      }
    }

    // R3 命名面：出现「… Design System / … 设计系统」时，同一行必须带唯一合法自称或基线路径
    let nameMentions = 0
    for (const rel of NAMING_SURFACE) {
      const file = resolve(root, rel)
      if (!existsSync(file)) {
        findings.push(`${rel}: 命名面文件缺失（自研口径无处声明）`)
        continue
      }
      const text = safeRead(file)
      if (text === undefined) {
        findings.push(`${rel}: 无法读取`)
        continue
      }
      const lines = text.split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(SELF_NAME_PATTERN)) {
          nameMentions += 1
          if (line.toUpperCase().includes(SELF_NAME.toUpperCase())) continue
          if (line.includes(`design/${BASELINE_DIR}`)) continue
          findings.push(
            `${rel}:${index + 1} [self-name] 视觉系统自称只能是「${SELF_NAME}」，` +
              `此行「${match[0].trim()}」既无自称也无基线路径`,
          )
        }
      }
    }

    // R4 锚点必须出现 SELF_NAME（含被删空的检查）
    for (const anchor of ANCHORS) {
      const file = resolve(root, anchor)
      if (!existsSync(file)) {
        findings.push(`${anchor}: 锚点文件缺失（口径声明无处落地）`)
        continue
      }
      const text = safeRead(file)
      if (text === undefined) {
        findings.push(`${anchor}: 无法读取`)
        continue
      }
      if (!text.toUpperCase().includes(SELF_NAME.toUpperCase())) {
        findings.push(`${anchor}: 未声明「${SELF_NAME}」自研口径`)
      }
    }

    notes.push(`形态命中：基线路径引用 ${String(pathRefs)} 处、设计系统自称 ${String(nameMentions)} 处`)
    return finish(findings, notes)
  },
}

/** 收齐扫描面文件（根级单文件 + SCAN_DIRS，含文件名判据所需的完整路径）。 */
function collectFiles(root: string): string[] {
  const found = walk(root, SCAN_DIRS, isTextFile)
  for (const name of ROOT_FILES) {
    const file = resolve(root, name)
    if (existsSync(file) && isTextFile(name) && !found.includes(file)) found.push(file)
  }
  return found.sort()
}

function safeRead(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function formatList(items: readonly string[]): string {
  return items.length === 0 ? '（空）' : items.join(', ')
}

/** findings 非空即不通过；这里集中一次，避免各处手写同一个表达式。 */
function finish(findings: string[], notes: string[]): GateResult {
  return { ok: findings.length === 0, findings, notes }
}

export { gate, BASELINE_DIR, SELF_NAME }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
