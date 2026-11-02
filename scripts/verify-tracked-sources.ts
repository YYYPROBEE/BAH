/**
 * 门禁：所有源码必须已入库，且相对导入必须指向已入库文件。
 *
 * 依据：BAH 代码修改清单 2026-10-20 · B0.2。
 *
 * 背景：上一轮出现过 `buffer.ts` / `history-cache.ts` 被主路径 import、
 * 却没有进版本库的情况——干净 clone 上 `typecheck` 直接失败。本门禁把
 * “源码在盘上”升级为“源码在版本库里”，并用相对导入做交叉验证。
 *
 * 扫描面：
 * - `packages/<pkg>/src/**`（TS/JS 源码）
 * - `scripts/**`（门禁与工具脚本）
 * - `services/rag/src/**`（Python 源码）
 *
 * 判定：
 * 1. `git ls-files --others --exclude-standard` 命中上述扫描面内的源码 → 失败；
 * 2. 任一相对 import/from 解析出的文件不在 `git ls-files` → 失败；
 * 3. git 不可用或不在仓库内 → 失败（门禁不能静默放行）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 参与“源码必须入库”判定的后缀。 */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
])

/** TS/JS 相对导入的解析顺序（覆盖仓库里带/不带扩展名的两种写法）。 */
const TS_RESOLVE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
] as const

/** 需要扫描的根目录（相对仓库根）。 */
const SCAN_ROOTS = ['packages', 'scripts', 'services/rag/src'] as const

const TS_IMPORT_PATTERNS: readonly RegExp[] = [
  // 说明符必须以点开头（相对路径）；示例见本门禁的测试夹具，不写进注释
  /\b(?:from|import)\s*['"](\.[^'"]+)['"]/g,
  // 动态 import / require
  /\b(?:import|require)\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
]

/** Python：from .module import x / from ..pkg.mod import x / from . import x。 */
const PY_FROM_PATTERN = /^\s*from\s+(\.+[\w.]*)\s+import\b/gm

interface SourceFile {
  /** 相对仓库根、统一使用 `/` 的路径。 */
  readonly rel: string
  /** 绝对路径。 */
  readonly abs: string
}

const gate: Gate = {
  name: 'tracked-sources',

  async run(root) {
    const findings: string[] = []
    const notes: string[] = []

    const tracked = gitList(root, ['ls-files', '-z'])
    if (tracked === undefined) {
      return {
        ok: false,
        findings: ['无法读取 git 索引：门禁必须在 git 仓库内执行（或 git 不可用）'],
        notes,
      }
    }
    const trackedSet = new Set(tracked.map(normalizeRel))

    const untracked = gitList(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    if (untracked === undefined) {
      return {
        ok: false,
        findings: ['无法读取未跟踪文件列表：git ls-files --others 执行失败'],
        notes,
      }
    }

    const sources = collectSources(root)

    for (const rel of untracked.map(normalizeRel).sort()) {
      if (!isScannedSource(rel)) continue
      findings.push(`${rel}: 源码未纳入版本库（git add 后重跑；干净 clone 会直接缺文件）`)
    }

    let importsChecked = 0
    for (const source of sources) {
      const text = readFileSafe(source.abs)
      if (text === undefined) {
        findings.push(`${source.rel}: 无法读取（权限或编码问题）`)
        continue
      }

      const imports =
        extname(source.rel) === '.py'
          ? pythonImports(source.rel, text)
          : typescriptImports(source.rel, text)

      for (const hit of imports) {
        importsChecked += 1
        const target = resolveImport(root, source.rel, hit.specifier, hit.kind)
        if (target === undefined) {
          findings.push(
            `${source.rel}:${hit.line} 无法解析相对导入 ${hit.specifier}（目标文件不存在）`,
          )
          continue
        }
        const targetRel = normalizeRel(target)
        if (!trackedSet.has(targetRel)) {
          findings.push(
            `${source.rel}:${hit.line} 引用了未入库文件 ${targetRel}（git add 后重跑）`,
          )
        }
      }
    }

    notes.push(
      `已核对 ${sources.length} 个源码文件、${importsChecked} 条相对导入；` +
        `未跟踪源码 ${untracked.filter(isScannedSource).length} 个`,
    )

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 执行 git 并返回 `-z` 分隔的路径列表；失败返回 undefined。 */
function gitList(root: string, args: readonly string[]): string[] | undefined {
  try {
    const output = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.split('\0').filter((item) => item.length > 0)
  } catch {
    return undefined
  }
}

/** 是否是扫描面内的源码。 */
function isScannedSource(rel: string): boolean {
  if (!SOURCE_EXTENSIONS.has(extname(rel))) return false
  if (rel.startsWith('packages/')) return rel.includes('/src/')
  if (rel.startsWith('scripts/')) return !rel.slice('scripts/'.length).includes('/')
  return rel.startsWith('services/rag/src/')
}

/** 递归收集扫描面内的源码（相对路径统一为 `/`）。 */
function collectSources(root: string): SourceFile[] {
  const found: SourceFile[] = []
  for (const sourceRoot of SCAN_ROOTS) {
    for (const abs of walk(root, [sourceRoot], (name) => SOURCE_EXTENSIONS.has(extname(name)))) {
      const rel = normalizeRel(relative(root, abs))
      if (isScannedSource(rel)) found.push({ rel, abs })
    }
  }
  return found.sort((left, right) => left.rel.localeCompare(right.rel))
}

interface ImportHit {
  readonly specifier: string
  readonly line: number
  readonly kind: 'ts' | 'py'
}

function typescriptImports(rel: string, text: string): ImportHit[] {
  const hits: ImportHit[] = []
  for (const pattern of TS_IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      hits.push({ specifier, line: lineOf(text, match.index ?? 0), kind: 'ts' })
    }
  }
  // 同一行重复匹配（静态 from 与动态 import 两种 pattern）只保留一次
  return dedupe(hits)
}

function pythonImports(rel: string, text: string): ImportHit[] {
  const hits: ImportHit[] = []
  for (const match of text.matchAll(PY_FROM_PATTERN)) {
    const raw = match[1]
    if (raw === undefined || !raw.startsWith('.')) continue
    const modulePart = raw.replace(/^\.+/, '')
    if (modulePart.length === 0) continue // `from . import x` 需要解析导入名，交由 runtime 校验
    hits.push({
      specifier: raw,
      line: lineOf(text, match.index ?? 0),
      kind: 'py',
    })
  }
  return hits
}

function dedupe(hits: readonly ImportHit[]): ImportHit[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const key = `${hit.line}:${hit.specifier}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/**
 * 把相对导入解析为相对仓库根的目标路径。
 *
 * TS：按 `TS_RESOLVE_EXTENSIONS` 与 `index.*` 探测；
 * Python：按 PEP 8 相对导入语义（点数量决定向上层级）。
 */
function resolveImport(
  root: string,
  sourceRel: string,
  specifier: string,
  kind: 'ts' | 'py',
): string | undefined {
  const sourceAbs = join(root, sourceRel)
  if (kind === 'py') {
    const match = /^(\.+)([\w.]*)$/.exec(specifier)
    if (match === null) return undefined
    const dots = match[1]?.length ?? 1
    const modulePart = match[2] ?? ''
    let base = dirname(sourceAbs)
    for (let i = 1; i < dots; i += 1) base = dirname(base)
    const parts = modulePart.length > 0 ? modulePart.split('.') : []
    const target = join(base, ...parts)
    for (const candidate of [`${target}.py`, join(target, '__init__.py')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return normalizeRel(relative(root, candidate))
      }
    }
    return undefined
  }

  const base = resolve(dirname(sourceAbs), specifier)
  for (const suffix of TS_RESOLVE_EXTENSIONS) {
    const candidate = `${base}${suffix}`
    if (isFile(candidate)) return normalizeRel(relative(root, candidate))
  }
  for (const suffix of TS_RESOLVE_EXTENSIONS) {
    if (suffix === '') continue
    const candidate = join(base, `index${suffix}`)
    if (isFile(candidate)) return normalizeRel(relative(root, candidate))
  }
  return undefined
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function normalizeRel(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '')
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
