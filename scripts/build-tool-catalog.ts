/**
 * 生成 `docs/tool-catalog.md`（施工单 08 §5 第 6 步）。
 *
 * 用法：`pnpm tool-catalog`。门禁 `verify-tool-catalog` 逐字比对，改了工具定义就重新生成。
 */

import { writeFileSync } from 'node:fs'

import { BANK_TOOL_LIMIT, BANK_TOOL_SPECS } from '../packages/bank/src/tools/specs.ts'
import { renderToolCatalog } from '../packages/bank/src/tools/render.ts'

import { projectRoot } from './gate-lib.ts'

/** 生成物路径（相对仓库根；与门禁同一常量）。 */
const CATALOG_DOC = 'docs/tool-catalog.md'

const root = projectRoot()
const target = `${root}/${CATALOG_DOC}`
const content = `${renderToolCatalog(BANK_TOOL_SPECS, BANK_TOOL_LIMIT)}\n`
writeFileSync(target, content, 'utf8')
console.log(`✔ 已生成 ${CATALOG_DOC}（${BANK_TOOL_SPECS.length} 个工具，上限 ${BANK_TOOL_LIMIT}）`)
