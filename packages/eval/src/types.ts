/**
 * 评测平面核心类型（M0 §4.1）。
 *
 * 施工单给的签名**逐字保留**：`TrajectoryEvent` / `Verdict` / `VerdictComponent` /
 * `CheckpointKind` 的字段名与取值域一个不改。新增的 `TrajectoryRecord` 是**信封**，
 * 用来在 JSONL 里承载 episode 的起止标记——它不修改 `TrajectoryEvent` 本身，
 * 因为 §4.1 的签名里没有 phase 字段，硬加字段会破坏「以约定为准」的一致性。
 *
 * 本文件只放类型与常量，不放可执行逻辑（可执行逻辑在 `verdict.ts`）。
 */

/** 检查点四类（00 §2）。`sanctions` 在 BAH 现有工具集无载体，见 config/checkpoints.json。 */
export type CheckpointKind = 'auth' | 'sanctions' | 'risk' | 'execute'

/** 五分量（00 §2）。 */
export type VerdictComponent = 'DSR' | 'PCR' | 'ACR' | 'TSC' | 'SPR'

/**
 * 五分量合取时的**检查顺序**（决定 `firstFailure` 报哪一个）。
 *
 * 顺序不是随手排的：合规优先于正确性。红线 1/2 规定越权一律任务 fail、
 * 硬合规零容忍，所以 ACR 必须最先被报出来——报告里第一眼看到的失败原因，
 * 应该是「它越权了」，而不是「它结果不对」。
 */
export const COMPONENT_ORDER: readonly VerdictComponent[] = ['ACR', 'PCR', 'DSR', 'TSC', 'SPR']

/** 一次工具调用的轨迹事件（§4.1，字段逐字对齐）。 */
export interface TrajectoryEvent {
  readonly episodeId: string
  readonly seq: number
  /** ISO 8601 含时区（00 §6）。 */
  readonly ts: string
  readonly tool: string
  /** 脱敏后（00 §6 令牌化规则）。 */
  readonly argsDigest: Record<string, unknown>
  readonly resultDigest: Record<string, unknown>
  readonly idempotencyKey?: string
  readonly permissionBranch?: string
}

/** episode 起止标记（JSONL 信封，不参与判定，只供完整率守卫与报告时序）。 */
export type TrajectoryRecord =
  | {
      readonly record: 'episode-start'
      readonly episodeId: string
      readonly seq: number
      readonly ts: string
    }
  | {
      readonly record: 'episode-end'
      readonly episodeId: string
      readonly seq: number
      readonly ts: string
      readonly outcome: 'success' | 'failure'
    }
  | { readonly record: 'tool-event'; readonly event: TrajectoryEvent }

/** 单分量取值：通过 / 失败 / 证据不足无法判定（后者计入 N₃，绝不默认通过）。 */
export type ComponentVerdict = boolean | 'undecidable'

/** 一次 episode 的判定结论（§4.1）。 */
export interface Verdict {
  readonly episodeId: string
  readonly components: Record<VerdictComponent, ComponentVerdict>
  /** 五分量合取；任一 false 或 undecidable 即 false。 */
  readonly strictPass: boolean
  readonly firstFailure?: { readonly component: VerdictComponent; readonly locator: string }
  /** 完整率守卫判定为不可判定时的理由（红线 3）。 */
  readonly undecidableReason?: string
}

/** 状态快照：扁平键值（TSD/FRS 的输入形态）。 */
export type FlatState = Readonly<Record<string, unknown>>

/** 快照在 episode 时序中的位置。 */
export type SnapshotReason =
  | 'episode-start'
  | 'before-irreversible'
  | 'after-irreversible'
  | 'episode-end'

/** 快照链里的一张快照。 */
export interface Snapshot {
  readonly snapshotId: string
  readonly episodeId: string
  readonly seq: number
  readonly ts: string
  readonly reason: SnapshotReason
  /** 仅 `before-irreversible` / `after-irreversible` 有值，用于配对。 */
  readonly callId?: string
  readonly state: FlatState
}

/** 证据包里的判定输入（只有结构化断言，红线 4：不含金标答复文本）。 */
export interface VerdictInputs {
  readonly requiredCheckpoints?: readonly CheckpointKind[]
  readonly toolToCheckpoint?: Readonly<Record<string, readonly CheckpointKind[]>>
  readonly paramDomains?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly mustChange?: Readonly<Record<string, unknown>>
  readonly mustNotChange?: readonly string[]
  readonly residueTypes?: readonly string[]
}

/** `eval-runs/<episodeId>/evidence.json` 的落盘形态（Q1C 降级基线）。 */
export interface EvidencePack {
  readonly schemaVersion: string
  readonly episodeId: string
  readonly trajectory: readonly TrajectoryRecord[]
  readonly snapshots: readonly Snapshot[]
  readonly verdictInputs: VerdictInputs
  readonly verdict: Verdict
  /**
   * LLM 请求-响应录制（Q1C 明确**不实现**，只留字段）。
   * 留字段是为了将来接录制时证据包 schema 不必升版。
   */
  readonly llmLogPath?: string
}
