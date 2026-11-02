/**
 * 门禁：工具目录 ↔ 源码一致。
 *
 * 五条校验：
 * 1. 数量 ≤ `BANK_TOOL_LIMIT`；
 * 2. 名字唯一、tier 合法、落账事件在 `BANK_SESSION_EVENT_TYPES` 内；
 * 3. 工厂表与目录一致（少实现即红；多实现由 `Record<BankToolName, …>` 在编译期兜住）；
 * 4. `docs/tool-catalog.md` 与 `renderToolCatalog()` 逐字一致（改了源码不重新生成 → 红）；
 * 5. **只读分支（`spec.readEvent`，R-9 / B-7）**：
 *    - 键必须在 `BANK_SESSION_EVENT_TYPES` 内（写错即红）；
 *    - 有 `readEvent` 的工具必须在 `READ_ONLY_ACTIONS` 有对应项（否则治理面照常签票，
 *      "只读"只是文档说法）；
 *    - 反向：`READ_ONLY_ACTIONS` 的每一项必须指向一个声明了 `readEvent` 的工具
 *      （否则豁免动作没有可回放的审计事件）。
 *
 * 文档是生成物：改工具定义后跑 `pnpm tool-catalog`。
 */

import { existsSync, readFileSync } from 'node:fs'

import { BANK_SESSION_EVENT_TYPES } from '../packages/bank/src/tools/events.ts'
import { renderToolCatalog } from '../packages/bank/src/tools/render.ts'
import { BANK_TOOL_LIMIT, BANK_TOOL_SPECS, type BankToolSpec } from '../packages/bank/src/tools/specs.ts'
import { READ_ONLY_ACTIONS } from '../packages/bank/src/tools/tier.ts'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

/** 生成物路径（相对仓库根）。 */
export const CATALOG_DOC = 'docs/tool-catalog.md'

/** 工厂表源码（只做词法核对，不 import 运行时代码——门禁不依赖 dist）。 */
const CATALOG_SOURCE = 'packages/bank/src/tools/catalog.ts'

const gate: Gate = {
  name: 'tool-catalog',

  async run(root) {
    const findings: string[] = []
    // 目录是 `as const satisfies` 的字面元组：不标注成 `BankToolSpec[]` 就读不到可选的 `readEvent`。
    const specs: readonly BankToolSpec[] = BANK_TOOL_SPECS

    if (specs.length > BANK_TOOL_LIMIT) {
      findings.push(
        `工具总数 ${specs.length} 超过上限 ${BANK_TOOL_LIMIT}（新增先删旧的）`,
      )
    }

    const seen = new Set<string>()
    let readEventCount = 0
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

    // 第 5 条：只读分支的三向一致（R-9 / B-7）。写错 readEvent 过去不会红。
    const readOnlyNames = new Set(READ_ONLY_ACTIONS.map((entry) => entry.name))
    for (const spec of specs) {
      if (spec.readEvent === undefined) continue
      readEventCount += 1
      if (!BANK_SESSION_EVENT_TYPES.includes(spec.readEvent)) {
        findings.push(`${spec.name}：只读事件 ${spec.readEvent} 不在 BANK_SESSION_EVENT_TYPES 内`)
      }
      if (!readOnlyNames.has(spec.name)) {
        findings.push(
          `${spec.name}：声明了 readEvent ${spec.readEvent}，但 READ_ONLY_ACTIONS 没有对应项` +
            `（治理面会把读分支当写操作签票）`,
        )
      }
    }
    for (const entry of READ_ONLY_ACTIONS) {
      const spec = specs.find((item) => item.name === entry.name)
      if (spec === undefined) {
        findings.push(`READ_ONLY_ACTIONS 指向不存在的工具：${entry.name}/${entry.action}`)
        continue
      }
      if (spec.readEvent === undefined) {
        findings.push(
          `READ_ONLY_ACTIONS 登记了 ${entry.name}/${entry.action}，但该工具没有声明 readEvent` +
            `（只读豁免没有可回放的审计事件）`,
        )
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
        `工具 ${specs.length} 个（上限 ${BANK_TOOL_LIMIT}）、落账事件 ${BANK_SESSION_EVENT_TYPES.length} 个、` +
          `只读分支 ${readEventCount} 个（READ_ONLY_ACTIONS ${READ_ONLY_ACTIONS.length} 条）`,
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
