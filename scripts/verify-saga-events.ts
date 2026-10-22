/**
 * 门禁：`append` / 派发点的事件名必须在 SA-00 §4.4 表内（SA-16 §5）。
 *
 * 词法扫描（与其它 verify-* 一致，不建 AST）：
 * - `SAGA_AUDIT.append(sagaId, 'type', ...)` 的第二参数字面量；
 * - `ctx.events.<mode>('saga/...', ...)` 的 saga 事件名。
 *
 * 允许集合 = `SAGA_EVENTS` 表内的 `saga/*` 键（状态机事件表，`SAGA_EVENT_KEYS` 同源）
 * + `SYSTEM_RECORDS` 里的系统级审计记录 + 复用的 4 个既有键（tool/call、tool/result、
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

/**
 * 系统级审计记录：只进链、不进状态机。
 *
 * 与 `SAGA_EVENTS` 分开列，是因为这两类东西的生命周期不同：
 * - `SAGA_EVENTS` 里每个键都必须是 `reduceSaga` 认识的转移/非转移事件（`SAGA_EVENT_KEYS` 同源），
 *   往里面塞系统级事实会连带改动状态机白名单与全量转移验收；
 * - 这里的事件可能**连一笔 saga 都没有**（启动恢复失败就是），它只描述"系统发生了什么"，
 *   落在独立的审计链上（`system-startup`），不参与任何 saga 投影。
 *
 * 判据：新增一项前先问"它会不会改变某笔 saga 的状态？"——会，进 `SAGA_EVENTS`；不会，进这里。
 */
const SYSTEM_RECORDS = new Set(['saga/recovery-failed'])

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
        if (!SAGA_EVENTS.has(type) && !SYSTEM_RECORDS.has(type) && !REUSED_EVENTS.has(type)) {
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
        `允许集合：${String(SAGA_EVENTS.size)} 个状态机键 + ${String(SYSTEM_RECORDS.size)} 个系统级审计记录 + 4 个复用键（${[...REUSED_EVENTS].join(' / ')}）`,
      ],
    }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
