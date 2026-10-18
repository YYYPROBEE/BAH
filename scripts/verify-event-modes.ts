/**
 * 门禁：事件的 `@mode` 声明必须与派发点一致（施工单 00 §9 补充纪律 / 施工单 02 §3，M0 骨架版）。
 *
 * 为什么必须有：`@mode` 是**公开契约**——事件的派发模式（emit/serial/parallel/waterfall/bail）
 * 决定插件怎么用它；声明与实际派发点分叉，等于让监听器按错误语义被调用。
 *
 * 现状：事件总表（`BahEventMap` 的逐键声明 + 各自 `@mode`）在施工单 04 §6 才冻结，
 * 因此本脚本先落地「扫描 + 比对」骨架：零声明点、零字面量派发点时按骨架规则通过并注明 TODO。
 *
 * 实现说明（与 M0 其他门禁一致）：**词法**定位，不建 AST——
 * - 声明点：`'事件名':` 形式的表项行，其前 `DECLARATION_WINDOW` 行的注释里带 `@mode <mode>`；
 * - 派发点：`.emit('事件名'` 之类**字面量**事件名（变量事件名无法静态比对，留给运行期与评审）；
 * - 测试文件不参与：测试里的字面量事件名不构成契约。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 声明点向前回溯多少行去找 `@mode`（JSDoc 通常紧贴表项）。 */
const DECLARATION_WINDOW = 20

/** 声明点：`'事件名':` / `"事件名":`。 */
const DECLARATION = /^\s*(['"])([\w.:/-]+)\1\s*:/

/** 派发点：`.<mode>('事件名'`。 */
const DISPATCH = /\.(emit|serial|parallel|waterfall|bail)\(\s*(['"])([\w.:/-]+)\2/

/** `@mode emit` 之类的标注。 */
const MODE_TAG = /@mode\s+(emit|serial|parallel|waterfall|bail)\b/

/** 只扫包内源码，不扫产物、声明文件与测试。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

interface Declaration {
  readonly file: string
  readonly line: number
  readonly event: string
  readonly mode: string
}

interface Dispatch {
  readonly file: string
  readonly line: number
  readonly event: string
  readonly mode: string
}

const gate: Gate = {
  name: 'event-modes',

  async run(root) {
    const files = walk(root, ['packages', 'apps'], isSource)
    const declarations: Declaration[] = []
    const dispatches: Dispatch[] = []

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        const declaration = DECLARATION.exec(line)
        if (declaration) {
          const mode = findModeTag(lines, index)
          if (mode !== undefined) {
            declarations.push({ file, line: index + 1, event: declaration[2]!, mode })
          }
        }
        const dispatch = DISPATCH.exec(line)
        if (dispatch) {
          dispatches.push({
            file,
            line: index + 1,
            mode: dispatch[1]!,
            event: dispatch[3]!,
          })
        }
      }
    }

    const declared = new Map(declarations.map((entry) => [entry.event, entry]))
    const findings: string[] = []

    for (const dispatch of dispatches) {
      const declaration = declared.get(dispatch.event)
      if (!declaration) {
        findings.push(
          `${relative(root, dispatch.file)}:${dispatch.line} 事件 "${dispatch.event}" 按 ${dispatch.mode} 派发，但没有对应的 @mode 声明（施工单 00 §9 / 04 §6）`,
        )
        continue
      }
      if (declaration.mode !== dispatch.mode) {
        findings.push(
          `${relative(root, dispatch.file)}:${dispatch.line} 事件 "${dispatch.event}" 声明为 ${declaration.mode}，实际按 ${dispatch.mode} 派发（声明点 ${relative(root, declaration.file)}:${declaration.line}）`,
        )
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes:
        declarations.length === 0 && dispatches.length === 0
          ? [
              'M0：事件总表尚未冻结（施工单 04 §6），零 @mode 声明点、零字面量派发点，按骨架规则通过。',
              'TODO(施工单 04 §6)：事件总表冻结后，改为逐条校验「每个事件都有 @mode」+ 派发点事件名必须在该表内。',
            ]
          : [
              `声明点 ${declarations.length} 个、字面量派发点 ${dispatches.length} 个，逐条比对 mode`,
              'TODO(施工单 04 §6)：事件总表冻结后，补充「表外事件名派发即失败」。',
            ],
    }
  },
}

/** 声明点之前 DECLARATION_WINDOW 行内的 `@mode`。 */
function findModeTag(lines: readonly string[], from: number): string | undefined {
  const start = Math.max(0, from - DECLARATION_WINDOW)
  for (let index = from; index >= start; index -= 1) {
    const matched = MODE_TAG.exec(lines[index] ?? '')
    if (matched) return matched[1]!
  }
  return undefined
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
