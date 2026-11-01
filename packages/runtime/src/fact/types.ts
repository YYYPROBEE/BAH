/**
 * 生活事实库（G3）：人物 / 关系 / 日期 / 偏好四类入库。
 *
 * 四条纪律（对外说明第 2 问的落点）：
 * 1. **最小化**：只存用户说过或确认过的字段；没有"推断"字段（`inferred` / `guess` / `confidence` 一律不许出现，门禁 I10）；
 * 2. **来源回链**：每条事实带 `sourceTurn`，可回到原话所在的回合；
 * 3. **首次可见**：`confirmed:false` 的事实会在计划卡里显式标"待确认"；
 * 4. **随时忘掉**：`fact_forget` 是黄级 + 打字确认（`confirmText:'删除'`），删除本身也落 `tool/result`，可回放。
 */

/** 人物关系（封闭联合）。 */
export type FactRelation = 'self' | 'spouse' | 'parent' | 'child' | 'other'

/** 事实种类（封闭联合）。 */
export type FactKind = 'birthday' | 'anniversary' | 'obligation' | 'preference'

/** 全部关系（门禁与 UI 用）。 */
export const FACT_RELATIONS: readonly FactRelation[] = ['self', 'spouse', 'parent', 'child', 'other']

/** 全部种类。 */
export const FACT_KINDS: readonly FactKind[] = ['birthday', 'anniversary', 'obligation', 'preference']

/** 一条生活事实。 */
export interface LifeFact {
  readonly factId: string
  /** 人物称谓（脱敏口径：用"爱人/母亲"这类称谓，不要求全名）。 */
  readonly person: string
  readonly relation: FactRelation
  readonly kind: FactKind
  /** ISO 日期（`YYYY-MM-DD`）；偏好类可缺省。 */
  readonly date?: string
  /** 偏好 / 义务的自由描述（用户原话脱敏后）。 */
  readonly note?: string
  /** 来源回合（可回链到原话）。 */
  readonly sourceTurn: number
  /** 首次使用前必须为 true；`fact_remember` 重复一次同类事实即视为"再确认"。 */
  readonly confirmed: boolean
  /** 每次修改 +1；授权窗口的 `fact-unchanged` 条件按它比对。 */
  readonly version: number
  /** 最后修改时刻（注入时钟）。 */
  readonly updatedAt: number
}

/** 写入入参（`sourceTurn` 由宿主注入，模型不可传）。 */
export interface FactRememberInput {
  readonly person: string
  readonly relation: FactRelation
  readonly kind: FactKind
  readonly date?: string
  readonly note?: string
  readonly confirmed?: boolean
}

/** 账本接口（进程内；重启由 `replayFacts` 重建）。 */
export interface FactStore {
  /** `sourceTurn` 由宿主注入（模型不可传），用于把事实回链到原话所在回合。 */
  readonly remember: (input: FactRememberInput, at: number, sourceTurn: number) => LifeFact
  readonly list: (filter?: { readonly person?: string; readonly kind?: FactKind }) => readonly LifeFact[]
  readonly get: (factId: string) => LifeFact | undefined
  readonly forget: (factId: string) => LifeFact
  /** 供授权窗口取版本表（`fact-unchanged` 条件）。 */
  readonly versions: () => Readonly<Record<string, number>>
}

/** **禁止**出现在出参里的推断字段（门禁 I10 的判据源）。 */
export const FORBIDDEN_INFERENCE_KEYS = ['inferred', 'guess', 'confidence'] as const

/** 工具名。 */
export const FACT_REMEMBER_TOOL = 'fact_remember'
export const FACT_LIST_TOOL = 'fact_list'
export const FACT_FORGET_TOOL = 'fact_forget'

/** 单条 note 的长度上限。 */
export const MAX_FACT_NOTE_LENGTH = 200

/** 单会话事实条数上限（超过即 fail-loud：账本变噪声比崩溃更贵）。 */
export const MAX_FACTS = 64
