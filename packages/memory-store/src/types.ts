/**
 * 跨会话记忆层 · 类型唯一源（施工文档 §3）。
 *
 * 本文件只放**形状**，不放行为：词表在 `words.ts`，判决在 `gates/`，读写语义在
 * `store/` 与 `read/`。所有跨文件引用都从这里取类型，避免同一概念两处定义漂移。
 */

/* ────────────────────────────── 场景 ────────────────────────────── */

/**
 * 六个已注册业务场景。
 *
 * 注意与 `@bah/bank` 的 `TxnCategory` 区分：那里的 `'transfer'` 是**交易分类**，
 * 这里是**业务场景标签**。同名不同义，刻意不复用银行域类型——复用会把交易流水
 * 误当作场景白名单命中（见 `words.ts` 的 scene 白名单）。
 */
export const SCENES = ['transfer', 'bills', 'investment', 'card', 'subscription', 'cross_scene'] as const

export type Scene = (typeof SCENES)[number]

/** 运行时白名单校验用的集合（`readonly` 以阻止调用方改写）。 */
export const SCENE_SET: ReadonlySet<string> = new Set(SCENES)

/* ────────────────────────────── 记忆单元 ────────────────────────────── */

export type UnitType = 'entity_fact' | 'preference'
export type UnitState = 'active' | 'superseded' | 'frozen'
export type SourceType = 'user_statement'
export type ShadowState = 'verified' | 'stale' | 'n_a'
export type VaultState = 'pending_confirm' | 'active' | 'retired'

/* ────────────────────────────── 结果码 ────────────────────────────── */

/**
 * 写入管道的结果码（零静默丢弃：每条被拒的候选都必须落到其中之一）。
 *
 * `PASS` 之外的每个码都是**给人看的理由**，不是内部枚举——答辩时要能逐条解释。
 */
export type GateCode =
  | 'PASS'
  | 'EXTRACT_NO_CANDIDATE'
  | 'EXTRACT_SPO_INCOMPLETE'
  | 'EXTRACT_SUBJECT_UNRESOLVED'
  | 'GATE_PREDICATE_UNKNOWN'
  | 'GATE_NO_BASIS'
  | 'GATE_SENSITIVITY'
  | 'GATE_INJECTION'
  | 'IDEMPOTENT_SKIP'
  | 'ROUTE_VAULT_PENDING'
  /**
   * 通道隔离拒绝（本包对 §3 的扩展）。
   *
   * 文档没有这个码，原先拿 `EXTRACT_NO_CANDIDATE` 顶替——那会让审计把「工具输出被挡在门外」
   * 读成「这句话里没抽到东西」，两件事的责任方完全不同（前者是越权通道，后者是表达不清）。
   */
  | 'CHANNEL_REJECTED'

/**
 * 读取路由的结果码（施工文档 §7.1）。
 *
 * 独立于 `GateCode`：写侧是"要不要收"，读侧是"要不要查"，混在一个联合里会让
 * 调用方分不清拒绝发生在哪个方向。
 */
export type RouteCode = 'ROUTE_OK' | 'EMPTY_UNKNOWN_SCENE' | 'CROSS_SCENE_REFUSED'

/* ────────────────────────────── 候选与抽取 ────────────────────────────── */

/** 规则抽取的模式号（禁 LLM：每个候选都能追到一条正则）。 */
export type PatternId = 'P1' | 'P2' | 'P3' | 'P4'

/** 进入 KV 存储的候选。`subject` 已规范化（`user` / `card:8888` / `alias:工资卡` / `payee:房东`）。 */
export interface MemoryCandidate {
  readonly subject: string
  readonly predicate: string
  readonly object: unknown
  readonly scene: Scene
  readonly source: SourceType
  readonly pattern: PatternId
  /** 命中原文片段，供审计与答辩回溯。 */
  readonly rawSpan: string
  readonly confidence: number
}

/** 进入金库（程序性记忆）的候选：**不写** `memory_unit`。 */
export interface VaultCandidate {
  readonly triggerDesc: string
  readonly actionDesc: string
  readonly rawSpan: string
  readonly confidence: number
}

/** 抽取输出：两类候选分流，互不混淆。 */
export interface ExtractionResult {
  readonly memories: readonly MemoryCandidate[]
  readonly vaults: readonly VaultCandidate[]
  /**
   * 主体解析失败（如"我的卡注销了"但会话里没提过任何卡）。
   *
   * 单独一栏而不是塞进 `memories` 再标废：调用方要拿它生成**反问建议**，
   * 与"这条不合规被拒"是两种完全不同的用户体验。
   */
  readonly unresolved: readonly { readonly family: string; readonly suggestion: string }[]
}

/* ────────────────────────────── 溯源与事件 ────────────────────────────── */

export interface Provenance {
  readonly session_id: string
  readonly turn_id: number
  readonly pipeline: { readonly extractor: 'rules@v1'; readonly pattern: PatternId }
}

/**
 * 记忆层事件。
 *
 * `gate_rejected` 与 `injection_rejected` 分开：前者是"不合规但无害"，后者是
 * **攻击信号**，答辩要看的是后者的条数。
 */
export interface MemoryEvent {
  readonly type: 'injection_rejected' | 'procedural_change' | 'gate_rejected'
  readonly detail: Readonly<Record<string, unknown>>
  readonly ts: string
}

export interface GateResult {
  readonly code: GateCode
  readonly reason?: string
  readonly event?: MemoryEvent
}

/* ────────────────────────────── 写入面 ────────────────────────────── */

export interface IngestInput {
  readonly tenant: string
  readonly user_id: string
  readonly session_id: string
  readonly turn_id: number
  readonly scene: Scene
  readonly speaker: 'user' | 'agent' | 'tool'
  readonly text: string
  /** 会话内近期实体键（`card:8888` / `subscription:netflix`），P3 指代解析用。 */
  readonly recentEntities?: readonly string[]
}

export interface IngestResult {
  readonly candidates: number
  readonly written: number
  readonly superseded: readonly string[]
  readonly vaultPending: readonly string[]
  readonly rejected: readonly GateResult[]
}

/* ────────────────────────────── 读取面 ────────────────────────────── */

export interface RetrieveQuery {
  readonly tenant: string
  readonly user_id: string
  readonly session_id: string
  readonly scene: Scene | 'unknown'
  /** 显式跨域借用；`confidence < 0.6` → 拒借 + 反问建议（施工文档 §7.1）。 */
  readonly crossSceneRef?: { readonly target: Scene; readonly confidence: number }
  readonly maxK?: number
}

export interface EntityRef {
  readonly kind: 'card' | 'subscription' | 'account'
  readonly key: string
}

/** 银行工具返回的权威状态。`status` 用开放字符串：不同实体族的状态词不同。 */
export interface EntityState {
  readonly status: string
  readonly asOf: string
}

/**
 * 注入式银行查询端口（memory 包**不 import** 任何底座包）。
 *
 * 返回 `null` 的语义必须由实现方说明清楚：是"实体不存在"还是"接口未实现"。
 * 两者绝不可混用——把"接口没实现"读成"卡已注销"会制造假证据（M3 影子核验的
 * fail-closed 依赖这条边界）。
 */
export type BankQuery = (ref: EntityRef) => Promise<EntityState | null>

export interface RetrievedMemory {
  readonly unitId: string
  readonly sceneTag: Scene
  readonly sourceScene: Scene
  readonly confidence: number
  readonly asOf: string
  readonly shadow: ShadowState
  readonly renderedText: string
  readonly lastVerifiedAt?: string
}

export interface AccessLogLine {
  readonly ts: string
  readonly session_id: string
  readonly scene: string
  readonly queryPlan: {
    readonly domains: readonly Scene[]
    readonly crossSceneRef?: { readonly target: Scene; readonly accepted: boolean }
  }
  /** 过滤前命中 id。 */
  readonly retrieved: readonly string[]
  readonly filteredOut: readonly { readonly unitId: string; readonly reason: string }[]
  /** 最终进入上下文。 */
  readonly injected: readonly string[]
  readonly shadowVerifications: readonly {
    readonly unitId: string
    readonly tool: 'bankQuery'
    readonly ok: boolean
    readonly latencyMs: number
  }[]
}

export interface RetrieveResult {
  readonly memories: readonly RetrievedMemory[]
  readonly logLine: AccessLogLine
  /**
   * 路由判决码（本包对 §3 的扩展）。
   *
   * 理由：T1.5「unknown fail-closed」必须能断言"没查"，而 `AccessLogLine` 是审计面，
   * 不该承担判决语义。放在结果顶层，调用方读一处即可知道该不该追问用户。
   */
  readonly routeCode: RouteCode
}

/* ────────────────────────────── 金库 ────────────────────────────── */

export interface ProceduralUnit {
  readonly procId: string
  readonly tenant: string
  readonly userId: string
  readonly triggerDesc: string
  readonly actionDesc: string
  readonly state: VaultState
  readonly version: number
  readonly confirmations: readonly ConfirmationRecord[]
  readonly provenance: Provenance
  readonly createdAt: string
}

export interface ConfirmationRecord {
  readonly session_id: string
  readonly turn_id: number
  readonly ts: string
  readonly matched_phrase: string
}

export interface ConfirmInput {
  readonly tenant: string
  readonly user_id: string
  readonly session_id: string
  readonly turn_id: number
  readonly text: string
}
