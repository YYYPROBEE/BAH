/**
 * 门禁：`append` / 派发点的事件名必须在 SA-00 §4.4 表内（SA-16 §5）。
 *
 * 词法扫描（与其它 verify-* 一致，不建 AST）：
 * - `SAGA_AUDIT.append(sagaId, 'type', ...)` 的第二参数字面量；
 * - `ctx.events.<mode>('saga/...', ...)` 的 saga 事件名。
 *
 * 允许集合 = 16 个 `saga/*` 键 + 复用的 4 个既有键（tool/call、tool/result、
 * approval/asked、approval/decided）。测试文件不构成契约，不参与扫描。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

const SAGA_EVENTS = new Set([
  'saga/created',
  'saga/step-planned',
  'saga/param-validated',
  'saga/call-result',
  'saga/unknown-probe',
  'saga/comp-decided',
  'saga/comp-issued',
  'saga/comp-result',
  'saga/dlq-escalated',
  'saga/residual-recorded',
  'saga/reconciled',
  'saga/manually-closed',
  'saga/vault-accessed',
  'saga/recovered',
  'saga/anchor-published',
  'saga/tick',
])

const REUSED_EVENTS = new Set(['tool/call', 'tool/result', 'approval/asked', 'approval/decided'])

const APPEND = /\.append\(\s*[^,]{1,160},\s*'([^']+)'/g
const SAGA_DISPATCH = /\.(?:emit|serial|parallel|waterfall|bail)\(\s*'(saga\/[^']+)'/g

const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

const gate: Gate = {
  name: 'saga-events',

  async run(root) {
    const files = walk(root, ['packages/saga/src', 'packages/persistence/src/chain'], isSource).concat(
      walk(root, ['packages/host/src/boot/plugins'], (name) => isSource(name)),
    )
    const findings: string[] = []
    let appendCount = 0
    let dispatchCount = 0

    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const matched of text.matchAll(APPEND)) {
        appendCount += 1
        const type = matched[1] as string
        if (!SAGA_EVENTS.has(type) && !REUSED_EVENTS.has(type)) {
          findings.push(`${relative(root, file)} 的 append 事件名 "${type}" 不在 SA-00 §4.4 表内`)
        }
      }
      for (const matched of text.matchAll(SAGA_DISPATCH)) {
        dispatchCount += 1
        const type = matched[1] as string
        if (!SAGA_EVENTS.has(type)) {
          findings.push(`${relative(root, file)} 派发了表外 saga 事件 "${type}"`)
        }
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `扫描 ${files.length} 个源文件：append ${appendCount} 处、saga 派发点 ${dispatchCount} 处`,
        `允许集合：16 个 saga 键 + 4 个复用键（${[...REUSED_EVENTS].join(' / ')}）`,
      ],
    }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
