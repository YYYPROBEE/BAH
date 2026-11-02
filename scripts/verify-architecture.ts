/**
 * 门禁：架构文档与代码一致（W19 的 TC-W19-01/02/04/05/06/07/08/09）。
 *
 * 为什么这是一道**门禁**而不是"写完检查一遍"：架构图最常见的失效方式是"代码改了、图没改"。
 * 本门禁每次都重新算一遍生成块，与文档里的块逐字节比对——过期即红。
 *
 * 判据（逐条对应设计）：
 * - TC-W19-01 注册表图里的每个组件名都在 `HOST_PLUGINS` 里（抓"手改图加了个不存在的组件"）；
 * - TC-W19-02 重跑 diff=0（`staleDocs()` 为空）；
 * - TC-W19-04 安全设计的攻击面表 ≥12 项，且每项都有"缺口"列（不许只写防线不写缺口）；
 * - TC-W19-05 未实现清单 ≥5 项，每项写清"为什么不做"与"影响面"；
 * - TC-W19-06 三份文档的事实表块**逐字节相同**（同一块注入，结构上不可能互相矛盾）；
 * - TC-W19-07 装配图里 `channel:web` / `plan:dag` 在其他 profile 里是"未装配"虚线；
 * - TC-W19-08 每个 profile 的装配行都指向注册表里存在的插件，且矩阵覆盖注册表全部组件；
 * - TC-W19-09 覆盖率表述同时带"行口径"与"包口径"标签。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HOST_PLUGINS } from '../packages/host/src/boot/plugins/index.ts'
import {
  blockOf,
  computeArchitecture,
  DOC_PATHS,
  staleDocs,
} from './gen-architecture.ts'
import type { Gate, GateResult } from './gate-lib.ts'
import { isMainModule, runStandalone } from './gate-lib.ts'

/** 从一段 markdown 里切出某两级标题之间的内容。 */
function sectionOf(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  if (start < 0) return ''
  const end = text.indexOf(to, start + from.length)
  return end < 0 ? text.slice(start) : text.slice(start, end)
}

/** 数表格里"编号行"的条数，并返回每行的单元格数。 */
function numberedRows(text: string): string[][] {
  const rows: string[][] = []
  for (const line of text.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim())
    rows.push(cells)
  }
  return rows
}

const gate: Gate = {
  name: 'architecture',

  async run(root: string): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

    /* ── TC-W19-02：生成块是否最新 ───────────────────────────────────── */
    const stale = await staleDocs(root)
    for (const rel of stale) {
      findings.push(`${rel}: 生成块已过期（跑 npx tsx scripts/gen-architecture.ts 重写）`)
    }

    const snapshot = await computeArchitecture(root)
    const registryIds = new Set(HOST_PLUGINS.map((item) => item.id))
    const architecture = read(DOC_PATHS.architecture)

    /* ── TC-W19-01：文档里出现的组件名必须来自注册表 ────────────────── */
    // 分层表用行内代码写组件名：抓所有 `xxx:yyy` 形态的代码片段
    const layersBlock = blockOf(architecture, 'layers')
    const tableNames = [...layersBlock.matchAll(/`([a-z][\w-]*:[\w-]+)`/g)].map((match) => match[1] ?? '')
    const graphLabels = [...blockOf(architecture, 'dependency-graph').matchAll(/"[^"]*?([a-z][\w-]*:[\w-]+)"/g)].map(
      (match) => match[1] ?? '',
    )
    const foreign = [...new Set([...tableNames, ...graphLabels])].filter((label) => !registryIds.has(label))
    for (const label of foreign) {
      findings.push(`docs/architecture.md: 组件 ${label} 不在 HOST_PLUGINS 里（图/表里出现了不存在的组件）`)
    }
    const drawn = new Set([...tableNames, ...graphLabels])
    for (const id of registryIds) {
      if (!drawn.has(id)) findings.push(`docs/architecture.md: 漏画/漏列了 ${id}（注册表里有）`)
    }
    notes.push(`组件覆盖 ${String([...registryIds].filter((id) => drawn.has(id)).length)}/${String(registryIds.size)}（分层表 + 依赖图）`)

    /* ── TC-W19-07：装配图必须体现 profile 差异 ────────────────────── */
    const assemblyBlock = blockOf(architecture, 'assembly')
    const expectations: readonly { readonly id: string; readonly profile: string }[] = [
      { id: 'channel:web', profile: 'headless' },
      { id: 'channel:web', profile: 'plan' },
      { id: 'plan:dag', profile: 'web' },
    ]
    for (const item of expectations) {
      const ghost = `${item.id}（未装配）`
      if (!assemblyBlock.includes(ghost)) {
        findings.push(`docs/architecture.md: 装配图缺少"${item.id}"在 profiles/${item.profile} 的未装配节点`)
      }
    }
    if (assemblyBlock.includes('enabled: false') === false) {
      findings.push('docs/architecture.md: 装配图没有标出"装配但关闭"的组件（bank:saga-bridge 在 plan）')
    }

    /* ── TC-W19-08：装配行必须指向注册表，矩阵必须全量 ─────────────── */
    for (const assembly of snapshot.assemblies) {
      for (const row of assembly.rows) {
        if (!registryIds.has(row.use)) {
          findings.push(
            `profiles/${assembly.name}: 行 ${row.id} 的 use=${row.use} 不在 HOST_PLUGINS 里（装配了不存在的插件）`,
          )
        }
      }
      const absentCount = [...assembly.states.values()].filter((state) => state === 'absent').length
      notes.push(
        `profiles/${assembly.name}: 生效 ${String(
          [...assembly.states.values()].filter((state) => state === 'active').length,
        )} / 关闭 ${String(
          [...assembly.states.values()].filter((state) => state === 'disabled').length,
        )} / 未装配 ${String(absentCount)}`,
      )
    }
    const matrixBlock = blockOf(architecture, 'matrix')
    const matrixRows = matrixBlock
      .split('\n')
      .filter((line) => /^\|\s*[a-z][\w-]*:[\w-]+\s*\|/.test(line))
    for (const id of registryIds) {
      if (!matrixRows.some((line) => line.startsWith(`| ${id} |`))) {
        findings.push(`docs/architecture.md: 装配矩阵缺 ${id} 这一行`)
      }
    }

    /* ── TC-W19-06 / TC-W19-09：三份文档共用同一块事实表 ───────────── */
    const factsBlocks = Object.values(DOC_PATHS).map((rel) => blockOf(read(rel), 'facts'))
    const reference = factsBlocks[0] ?? ''
    if (reference.trim().length === 0) {
      findings.push('docs/architecture.md: 事实表块为空')
    }
    for (const [index, rel] of Object.values(DOC_PATHS).entries()) {
      if (factsBlocks[index] !== reference) {
        findings.push(`${rel}: 事实表与 docs/architecture.md 不一致（同一块必须逐字节相同）`)
      }
    }
    if (!reference.includes('行口径') || !reference.includes('包口径')) {
      findings.push('事实表: 覆盖率一行必须同时带"行口径"与"包口径"标签（TC-W19-09）')
    }

    /* ── TC-W19-04：攻击面表 ≥12 项，且每项都写了缺口 ──────────────── */
    const security = read(DOC_PATHS.security)
    const surface = sectionOf(security, '## 3. 攻击面清单', '## 4. 未实现清单')
    const surfaceRows = numberedRows(surface)
    if (surfaceRows.length < 12) {
      findings.push(`docs/security-design.md: 攻击面清单只有 ${String(surfaceRows.length)} 项（要求 ≥12）`)
    }
    // 四列：序号 / 攻击面 / 防线 / 缺口。三列的写法说明缺口被省掉了
    for (const [index, cells] of surfaceRows.entries()) {
      if (cells.length < 4) {
        findings.push(
          `docs/security-design.md: 攻击面第 ${String(index + 1)} 行缺"缺口"列（现有 ${String(cells.length)} 列）`,
        )
      }
    }
    notes.push(`攻击面清单 ${String(surfaceRows.length)} 项`)

    /* ── TC-W19-05：未实现清单 ≥5 项 ───────────────────────────────── */
    const gaps = numberedRows(sectionOf(security, '## 4. 未实现清单', '## 5. 每条防线的复现命令'))
    if (gaps.length < 5) {
      findings.push(`docs/security-design.md: 未实现清单只有 ${String(gaps.length)} 项（要求 ≥5）`)
    }
    for (const [index, cells] of gaps.entries()) {
      if (cells.length < 4) {
        findings.push(
          `docs/security-design.md: 未实现第 ${String(index + 1)} 行没写清"为什么不做 / 影响面"（现有 ${String(cells.length)} 列）`,
        )
      }
    }
    notes.push(`未实现清单 ${String(gaps.length)} 项`)

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
