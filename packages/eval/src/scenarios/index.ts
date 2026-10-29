/**
 * 全部 71 个 eval 场景（W13 + 03/04 单）：族顺序 Q/T/P/S/D/K。
 *
 * 场景文件只导出数据；runner 与校验器在 `scenario/`。
 */

import { D_SCENARIOS } from './d/index.ts'
import { K_SCENARIOS } from './k/index.ts'
import { P_SCENARIOS } from './p/index.ts'
import { Q_SCENARIOS } from './q/index.ts'
import { S_SCENARIOS } from './s/index.ts'
import { T_SCENARIOS } from './t/index.ts'

import type { EvalScenario } from '../scenario/types.ts'

/** 71 个场景（顺序固定；runner 报告会再按族→ID 排序）。 */
export const ALL_SCENARIOS: readonly EvalScenario[] = [
  ...Q_SCENARIOS,
  ...T_SCENARIOS,
  ...P_SCENARIOS,
  ...S_SCENARIOS,
  ...D_SCENARIOS,
  ...K_SCENARIOS,
]

export { D_SCENARIOS, K_SCENARIOS, P_SCENARIOS, Q_SCENARIOS, S_SCENARIOS, T_SCENARIOS }
