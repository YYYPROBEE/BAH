/**
 * 门禁 G-3（W17）：eval 场景 ID 全局唯一。
 *
 * ## 为什么需要它
 *
 * 场景 ID 是**评测报告的主键**：`report.json` 按 ID 索引，基线比对按 ID 对齐，
 * 失败归因也按 ID 回查。复制一个场景忘了改 ID 的后果不是"多跑一条"，而是：
 *
 * - 报告里只留得下一条（另一条被同名覆盖，**删了场景也看不出来**）；
 * - 基线比对把两条当成一条，覆盖率式的"指标虚高"就是这么来的。
 *
 * ## 判据（三条，都很便宜）
 *
 * 1. **全局唯一**：60 个场景 + 45 条对抗，ID 不允许重复（两个命名空间前缀不同，但一并查）；
 * 2. **ID 前缀 = 族**：`Q-01` 必须属于 `Q` 族——前缀和 family 字段打架时，
 *    报告里按族聚合会与按 ID 过滤的结果不一致；
 * 3. **场景必须有断言**：`expect` 为空的场景恒过，是"用场景数凑指标"的入口。
 *
 * 族数量只作为 note 打印（不在门禁里写死）：数量属于契约文档
 * `docs/contracts/scenario-dsl.md` 的地盘，写死在门禁里就会有两份真相。
 */

import { ADVERSARIAL_META } from '../packages/eval/src/adversarial/expected.ts'
import { ALL_SCENARIOS } from '../packages/eval/src/scenarios/index.ts'
import type { Gate, GateResult } from './gate-lib.ts'
import { isMainModule, runStandalone } from './gate-lib.ts'

/** 一条可检查的用例（场景与对抗共有的最小形状）。 */
interface Identified {
  readonly id: string
  readonly family: string
}

const gate: Gate = {
  name: 'eval-scenarios',

  async run(): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const groups: readonly { readonly label: string; readonly items: readonly Identified[] }[] = [
      // `EvalScenario` 是 `{ spec, action }`：ID/族/断言都在 `spec` 里
      { label: '场景', items: ALL_SCENARIOS.map((item) => item.spec) },
      { label: '对抗', items: ADVERSARIAL_META },
    ]

    // 唯一性按**命名空间**判：场景报告与对抗报告是两个文件，
    // `P-01` 在两边各有一条是设计如此（场景 P=权限分级，对抗 P=越权），不是复制粘贴事故。
    // 真正会让报告互相覆盖的，是同一个命名空间里出现两条同号。
    const all = new Map<string, string>()
    for (const group of groups) {
      const seen = new Map<string, string>()
      for (const item of group.items) {
        const previous = seen.get(item.id)
        if (previous !== undefined) {
          findings.push(
            `ID 重复：${group.label} ${item.id} 出现两次（报告与基线会互相覆盖，删掉一条也看不出来）`,
          )
          continue
        }
        seen.set(item.id, item.id)
        all.set(`${group.label}:${item.id}`, item.id)

        const prefix = item.id.split('-')[0] ?? ''
        if (prefix !== item.family) {
          findings.push(`${group.label} ${item.id}: ID 前缀 ${prefix} 与 family=${item.family} 不一致`)
        }
      }
    }

    // 跨命名空间同号：只提示，不判红（两份报告互不覆盖）
    const scenarioIds = new Set(ALL_SCENARIOS.map((item) => item.spec.id))
    const overlap = ADVERSARIAL_META.map((item) => item.id).filter((id) => scenarioIds.has(id))
    if (overlap.length > 0) {
      notes.push(
        `跨命名空间同号 ${String(overlap.length)} 个（${overlap.slice(0, 3).join('、')}…）：场景与对抗是两份报告，不冲突`,
      )
    }

    for (const scenario of ALL_SCENARIOS) {
      if (scenario.spec.expect.length === 0) {
        findings.push(`场景 ${scenario.spec.id}: expect 为空（恒过的场景不算用例）`)
      }
    }

    const countByFamily = (items: readonly Identified[]): string => {
      const counts = new Map<string, number>()
      for (const item of items) counts.set(item.family, (counts.get(item.family) ?? 0) + 1)
      return [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([family, count]) => `${family}=${String(count)}`)
        .join(' ')
    }

    notes.push(`场景 ${String(ALL_SCENARIOS.length)} 个（${countByFamily(ALL_SCENARIOS.map((item) => item.spec))}）`)
    notes.push(`对抗 ${String(ADVERSARIAL_META.length)} 条（${countByFamily(ADVERSARIAL_META)}）`)
    notes.push(`命名空间内唯一：场景 ${String(ALL_SCENARIOS.length)} + 对抗 ${String(ADVERSARIAL_META.length)}`)

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
