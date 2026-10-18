/**
 * 门禁：会话事件与接缝事件的**声明一致性**（施工单 03 §1.4 / §5 验收清单）。
 *
 * 两条规则：
 * 1. **事件名必须在表内**：代码里 `append('x')` / `events.<mode>('x')` 的字面量事件名，
 *    必须出现在 `session/types.ts` 的 `SESSION_EVENT_TYPES` 或 `seams.ts` 的 `BahEventMap` 声明里。
 *    这条挡住「随手新造一个事件名」——没进表的事件既不落账也不可回放。
 * 2. **构造模型请求的入口白名单**：调用 `deriveMessages(` 的路径只允许在
 *    `session/`（投影本体）、`agent-loop/`（主循环装配请求）、`system-prompt/`（提示词装配）
 *    与 `@bah/llm`（wire 映射）。别处调用 = 绕过会话日志另造影子历史，直接阻断合并。
 *
 * 实现说明：**词法**扫描（与 M0 其他门禁一致，不建 AST）；测试文件不参与。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 会话事件表所在的文件（相对仓库根）。 */
const SESSION_TYPES = 'packages/runtime/src/session/types.ts'

/** 接缝事件表所在的文件（相对仓库根）。 */
const SEAMS = 'packages/runtime/src/seams.ts'

/** 允许调用 `deriveMessages(` 的路径前缀（相对仓库根的 posix 路径）。 */
const DERIVE_WHITELIST = [
  'packages/runtime/src/session/',
  'packages/runtime/src/agent-loop/',
  'packages/runtime/src/system-prompt/',
  'packages/llm/',
] as const

/** `session.append('x'` / `events.<mode>('x'` 的字面量。 */
const APPEND_CALL = /\.append\(\s*(['"])([\w.:/-]+)\1/
const DISPATCH_CALL = /\.(?:emit|serial|parallel|waterfall|bail)\(\s*(['"])([\w.:/-]+)\1/
const DERIVE_CALL = /\bderiveMessages\s*\(/

/** 只扫包内源码；测试不构成契约。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

const gate: Gate = {
  name: 'session-events',

  async run(root) {
    const declared = new Set<string>([
      ...readSessionTypeNames(root),
      ...readSeamNames(root),
    ])

    const findings: string[] = []
    const files = walk(root, ['packages', 'apps'], isSource)
    let checked = 0

    for (const file of files) {
      const where = toPosix(relative(root, file))
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if (isCommentLine(line)) continue
        const call = APPEND_CALL.exec(line) ?? DISPATCH_CALL.exec(line)
        if (call) {
          checked += 1
          const name = call[2]!
          if (!declared.has(name)) {
            findings.push(
              `${where}:${index + 1} 事件 "${name}" 未在 ${SESSION_TYPES} / ${SEAMS} 里声明（施工单 03 §1.2）`,
            )
          }
        }
        if (DERIVE_CALL.test(line) && !DERIVE_WHITELIST.some((prefix) => where.startsWith(prefix))) {
          findings.push(
            `${where}:${index + 1} deriveMessages 只允许在 session / agent-loop / system-prompt / llm 内调用（施工单 03 §1.4 硬门禁）`,
          )
        }
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [`声明事件 ${declared.size} 个，字面量派发点 ${checked} 处，扫描 ${files.length} 个源码文件`],
    }
  },
}

/** 从 `SESSION_EVENT_TYPES` 数组字面量里取事件名。 */
function readSessionTypeNames(root: string): string[] {
  const text = readFileSync(`${root}/${SESSION_TYPES}`, 'utf8')
  const start = text.indexOf('SESSION_EVENT_TYPES')
  if (start < 0) return []
  const end = text.indexOf('] as const', start)
  const block = text.slice(start, end < 0 ? undefined : end)
  return [...block.matchAll(/'([\w.:/-]+)'/g)].map((matched) => matched[1]!)
}

/** 从 `seams.ts` 的 BahEventMap 里取事件名（`'name':` 形式）。 */
function readSeamNames(root: string): string[] {
  const text = readFileSync(`${root}/${SEAMS}`, 'utf8')
  return [...text.matchAll(/^\s*'([\w.:/-]+)'\s*:/gm)].map((matched) => matched[1]!)
}

/** 注释行不参与扫描（文档里提到事件名或 deriveMessages 不构成调用）。 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

/** Windows 反斜杠 → posix（白名单按 posix 前缀比对）。 */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
