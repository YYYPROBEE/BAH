/**
 * 门禁：文档里的仓库路径必须真实存在（门禁扩容 07 §2-4）。
 *
 * 为什么必须做：`verify-tool-catalog.ts` 只保护 `docs/tool-catalog.md`，其余 11 份
 * `docs/*.md` 完全裸奔。而本项目的取证方式高度依赖"路径 + 行号"（`tech-debt-review` 里
 * 大量证据是 `packages/xxx/src/yyy.ts:123`）——路径一旦失效，评审就会基于不存在的文件做决策。
 *
 * 规则：
 * 1. 抽取 `docs/*.md`、`AGENTS.md` 里反引号包裹的仓库路径引用；
 * 2. 剥掉 `:行号` 后缀（`foo.ts:123` 与 `foo.ts:12-34` 都算同一个文件）；
 * 3. 跳过省略写法（含 `...`）与通配（含 `*`）、占位（含 `<`）——它们无法静态判定；
 * 4. 存在性检查；不在例外名单里的失效引用 → 违规。
 *
 * 例外名单（`scripts/docs-path-excludes.ts`）只收**规划中、尚未实装**的能力域路径：
 * 在文档里以规划路径出现是合理的（`tech-debt-review` D1 列过这批空壳能力域）。
 * 已实装包的失效引用一律改文档，不许进名单。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { DOCS_PATH_EXCLUSIONS } from './docs-path-excludes.ts'
import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

/** 受保护的文档面。 */
const DOC_FILES = ['AGENTS.md']

/** 引用必须落在这些顶层目录之一（其余如 `node_modules/...` 不是仓库自己的资产）。 */
const ROOTS = ['packages/', 'scripts/', 'services/', 'apps/', 'snapshots/', 'design/', 'docs/']

/** 反引号内的行内代码。 */
const CODE_SPAN = /`([^`\n]+)`/g

/** 行号后缀：`:123` 或 `:12-34`。 */
const LINE_SUFFIX = /:\d+(?:-\d+)?$/

const gate: Gate = {
  name: 'docs-paths',

  async run(root) {
    const findings: string[] = []
    const notes: string[] = []
    const seen = new Set<string>()
    let references = 0
    let excluded = 0

    for (const doc of docFiles(root)) {
      const text = readFileSync(join(root, doc), 'utf8')
      for (const match of text.matchAll(CODE_SPAN)) {
        const raw = (match[1] ?? '').trim()
        if (!isCandidate(raw)) continue
        references += 1

        const path = raw.replace(LINE_SUFFIX, '')
        if (seen.has(`${doc}\u0000${path}`)) continue
        seen.add(`${doc}\u0000${path}`)

        if (existsSync(join(root, path))) continue

        const exemption = DOCS_PATH_EXCLUSIONS.find((entry) => entry.path === path)
        if (exemption !== undefined) {
          excluded += 1
          continue
        }
        findings.push(`${doc}: 引用的 ${path} 不存在（${raw}）`)
      }
    }

    notes.push(
      `扫描 ${docFiles(root).length} 份文档、${references} 处路径引用；例外名单 ${DOCS_PATH_EXCLUSIONS.length} 条，命中 ${excluded} 处`,
    )

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 文档清单：根清单 + `docs/*.md`。 */
function docFiles(root: string): string[] {
  const docsDir = join(root, 'docs')
  const docs = existsSync(docsDir)
    ? readdirSync(docsDir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => `docs/${name}`)
    : []
  return [...DOC_FILES.filter((name) => existsSync(join(root, name))), ...docs]
}

/** 是否是"仓库路径"引用（排除命令、包名、URL、占位与通配）。 */
function isCandidate(raw: string): boolean {
  if (!ROOTS.some((prefix) => raw.startsWith(prefix))) return false
  if (raw.includes(' ') || raw.includes('\t')) return false
  // `...` 省略、`*` 通配、`{}` 花括号展开、`<>` 占位：都是示意写法，无法静态判定
  if (raw.includes('...') || /[*<>{}]/.test(raw)) return false
  if (raw.includes('://')) return false
  return true
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
