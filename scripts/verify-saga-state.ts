/**
 * 门禁：Saga 状态字典与转换表（SA-00 §8 / SA-07 T-SA07-002）。
 *
 * 比对对象是**代码里的常量**与本节硬编码的 SA-00 §4.1–4.3 字典：
 * 状态顺序、终态集合、合法出边、终态无出边。任一状态常量被改写即失败。
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

const TX_STATES = [
  'CREATED',
  'RUNNING',
  'SUCCEEDED',
  'ABORTED_CLEAN',
  'COMPENSATING',
  'COMPENSATED',
  'PARTIALLY_COMPENSATED',
  'PENDING_RISK_REVIEW',
  'GATE_HOLDING',
  'COMPENSATION_DLQ',
  'MANUALLY_CLOSED',
] as const

const TERMINAL = ['SUCCEEDED', 'ABORTED_CLEAN', 'COMPENSATED', 'MANUALLY_CLOSED'] as const

const STEP_STATES = [
  'PLANNED',
  'CALLING',
  'EXECUTED',
  'FAILED',
  'SKIPPED',
  'UNKNOWN',
  'PROBING',
  'UNRESOLVED',
  'COMP_ISSUED',
  'COMPENSATED',
] as const

const COMP_STATES = ['PENDING', 'ISSUED', 'OK', 'ERR', 'UNKNOWN', 'PROBING', 'DLQ'] as const

const EXPECTED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  CREATED: ['RUNNING'],
  RUNNING: [
    'SUCCEEDED',
    'ABORTED_CLEAN',
    'COMPENSATING',
    'PENDING_RISK_REVIEW',
    'GATE_HOLDING',
    'COMPENSATION_DLQ',
  ],
  PENDING_RISK_REVIEW: ['RUNNING', 'COMPENSATING', 'ABORTED_CLEAN'],
  GATE_HOLDING: ['RUNNING', 'COMPENSATING'],
  COMPENSATING: ['COMPENSATED', 'PARTIALLY_COMPENSATED', 'COMPENSATION_DLQ', 'MANUALLY_CLOSED'],
  PARTIALLY_COMPENSATED: ['COMPENSATING', 'MANUALLY_CLOSED'],
  COMPENSATION_DLQ: ['MANUALLY_CLOSED'],
  SUCCEEDED: [],
  ABORTED_CLEAN: [],
  COMPENSATED: [],
  MANUALLY_CLOSED: [],
}

/** 门禁只信任导出的常量形状。 */
interface StateModule {
  readonly SAGA_STATES: readonly string[]
  readonly TERMINAL_STATES: readonly string[]
  readonly STEP_STATES: readonly string[]
  readonly COMP_STATES: readonly string[]
  readonly SAGA_TRANSITIONS: Readonly<Record<string, readonly string[]>>
}

const gate: Gate = {
  name: 'saga-state',

  async run(root) {
    const path = join(root, 'packages', 'saga', 'src', 'index.ts')
    let module: StateModule
    try {
      const loaded = (await import(pathToFileURL(path).href)) as unknown
      module = loaded as StateModule
    } catch (error) {
      return {
        ok: false,
        findings: [`无法加载状态机常量：${error instanceof Error ? error.message : String(error)}`],
        notes: [],
      }
    }

    const findings: string[] = []

    compareList('SAGA_STATES', module.SAGA_STATES, TX_STATES, findings)
    compareList('TERMINAL_STATES', module.TERMINAL_STATES, TERMINAL, findings)
    compareList('STEP_STATES', module.STEP_STATES, STEP_STATES, findings)
    compareList('COMP_STATES', module.COMP_STATES, COMP_STATES, findings)

    const transitions = module.SAGA_TRANSITIONS
    const keys = Object.keys(transitions).sort()
    const expectedKeys = [...TX_STATES].sort()
    if (keys.join('|') !== expectedKeys.join('|')) {
      findings.push(
        `SAGA_TRANSITIONS 的 from 集合与状态字典不一致：代码 [${keys.join(', ')}]，字典 [${expectedKeys.join(', ')}]`,
      )
    }

    for (const state of TX_STATES) {
      const outs = transitions[state]
      if (outs === undefined) {
        findings.push(`SAGA_TRANSITIONS 缺少状态 ${state}`)
        continue
      }
      const expected = EXPECTED_TRANSITIONS[state]
      if (expected === undefined) continue
      if ([...outs].sort().join('|') !== [...expected].sort().join('|')) {
        findings.push(
          `${state} 的出边与 SA-00 §4.1 不一致：代码 [${outs.join(', ')}]，字典 [${expected.join(', ')}]`,
        )
      }
      for (const target of outs) {
        if (!(TX_STATES as readonly string[]).includes(target)) {
          findings.push(`${state} 的出边指向未声明状态 ${target}`)
        }
      }
    }

    for (const terminal of TERMINAL) {
      const outs = transitions[terminal]
      if (outs !== undefined && outs.length > 0) {
        findings.push(`终态 ${terminal} 不得有出边（当前 ${outs.join(', ')}）`)
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `已比对 ${TX_STATES.length} 个事务状态、${STEP_STATES.length} 个步骤状态、${COMP_STATES.length} 个补偿状态`,
        `已检查 ${Object.keys(transitions).length} 条 from 的出边与 ${TERMINAL.length} 个终态无出边`,
      ],
    }
  },
}

function compareList(
  name: string,
  actual: readonly string[],
  expected: readonly string[],
  findings: string[],
): void {
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    findings.push(`${name} 与 SA-00 字典不一致：代码 [${actual.join(', ')}]，字典 [${expected.join(', ')}]`)
  }
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
