/**
 * 门禁：工具目录 ↔ 源码一致（施工单 08 §0 第 4 条 / §6 T-TOOLS-010）。
 *
 * 四条校验：
 * 1. 数量 ≤ 28（施工单 08 §2 的上限）；
 * 2. 名字唯一、tier 合法、落账事件在 `BANK_SESSION_EVENT_TYPES` 内；
 * 3. 工厂表与目录一致（少实现即红；多实现由 `Record<BankToolName, …>` 在编译期兜住）；
 * 4. `docs/tool-catalog.md` 与 `renderToolCatalog()` 逐字一致（改了源码不重新生成 → 红）。
 *
 * 文档是生成物：改工具定义后跑 `pnpm tool-catalog`。
 */

import { existsSync, readFileSync } from 'node:fs'

import { BANK_SESSION_EVENT_TYPES } from '../packages/bank/src/tools/events.ts'
import { renderToolCatalog } from '../packages/bank/src/tools/render.ts'
import { BANK_TOOL_LIMIT, BANK_TOOL_SPECS } from '../packages/bank/src/tools/specs.ts'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

/** 生成物路径（相对仓库根）。 */
export const CATALOG_DOC = 'docs/tool-catalog.md'

/** 工厂表源码（只做词法核对，不 import 运行时代码——门禁不依赖 dist）。 */
const CATALOG_SOURCE = 'packages/bank/src/tools/catalog.ts'

const gate: Gate = {
  name: 'tool-catalog',

  async run(root) {
    const findings: string[] = []
    const specs = BANK_TOOL_SPECS

    if (specs.length > BANK_TOOL_LIMIT) {
      findings.push(
        `工具总数 ${specs.length} 超过上限 ${BANK_TOOL_LIMIT}（施工单 08 §2：新增先删旧的）`,
      )
    }

    const seen = new Set<string>()
    for (const spec of specs) {
      if (seen.has(spec.name)) findings.push(`工具名重复：${spec.name}`)
      seen.add(spec.name)
      if (!['green', 'yellow', 'red'].includes(spec.tier.level)) {
        findings.push(`${spec.name}：tier.level 非法（${String(spec.tier.level)}）`)
      }
      if (!BANK_SESSION_EVENT_TYPES.includes(spec.event)) {
        findings.push(`${spec.name}：落账事件 ${spec.event} 不在 BANK_SESSION_EVENT_TYPES 内`)
      }
    }

    const factorySource = readFileSync(`${root}/${CATALOG_SOURCE}`, 'utf8')
    for (const spec of specs) {
      if (!factorySource.includes(`'${spec.name}':`)) {
        findings.push(`${CATALOG_SOURCE} 缺少工具 ${spec.name} 的工厂（目录与实现不一致）`)
      }
    }

    const docPath = `${root}/${CATALOG_DOC}`
    if (!existsSync(docPath)) {
      findings.push(`缺少生成物 ${CATALOG_DOC}（跑 pnpm tool-catalog）`)
    } else {
      const actual = readFileSync(docPath, 'utf8').replace(/\r\n/g, '\n').trimEnd()
      const expected = renderToolCatalog(specs, BANK_TOOL_LIMIT).trimEnd()
      if (actual !== expected) {
        const at = firstDiffLine(actual, expected)
        findings.push(
          `${CATALOG_DOC} 与源码不一致（第一个差异在第 ${at + 1} 行）；跑 pnpm tool-catalog 重新生成`,
        )
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `工具 ${specs.length} 个（上限 ${BANK_TOOL_LIMIT}）、落账事件 ${BANK_SESSION_EVENT_TYPES.length} 个`,
      ],
    }
  },
}

/** 第一处差异的行号（0 基；长度不同时取较短者末尾）。 */
function firstDiffLine(left: string, right: string): number {
  const leftLines = left.split('\n')
  const rightLines = right.split('\n')
  const max = Math.max(leftLines.length, rightLines.length)
  for (let index = 0; index < max; index += 1) {
    if (leftLines[index] !== rightLines[index]) return index
  }
  return 0
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
