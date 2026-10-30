/**
 * 评测场景 DSL（W02 三件冻结之一）。
 *
 * **本文件只有类型，没有常量、没有函数、没有校验器。**
 * 原因同 `packages/util/src/tool-contract.ts`：`TC-W02-01/02` 要求类型文件不产生运行时代码；
 * 场景的运行与校验在 W13（`packages/eval/src/scenario/runner.ts`）。
 *
 * 设计口径：只冻结"能喂饱四项指标"的最小集，不预留字段。
 * 预留在 W17 的类型收紧里会变成负债（W02 §3 明令禁止）。
 *
 * 七族见 `docs/contracts/scenario-dsl.md` §2：
 * Q 查询 14 / T 转账主链 16 / P 权限分级 11 / S 补偿 8 / D 编排 15 / K 知识与拒答 10 / U 意图语料 17 = 91。
 */

/** 场景族。ID 前缀即族字母，形如 `T-03`。 */
export type ScenarioFamily = 'Q' | 'T' | 'P' | 'S' | 'D' | 'K' | 'U'

/**
 * 该场景计入哪一项指标。
 *
 * 只有三项需要显式标注——第四项"平均步数"由 `tool-sequence` 断言自动导出，不需要场景自己声明。
 * 缺省（不写）= 只跑不断言指标，用于回归保护场景。
 */
export type ScenarioMetric = 'task-success' | 'privilege-block' | 'refusal-accuracy'

/**
 * 审批应答模式。取值域来自 `ApprovalSettings`（`responder: 'none' | 'headless'`
 * + `autoDecision: 'allow' | 'reject' | 'cancel'`），**不新增第四种**。
 *
 * 为什么需要它：`profiles/headless` 把 `autoDecision` 固定成 `allow`，
 * 若场景不能改写这个维度，P 族（权限分级）10 个场景的结果会全部相同——测了个寂寞。
 */
export type ScenarioApproval = 'allow' | 'reject' | 'unavailable'

/**
 * 一条断言。
 *
 * 五种 kind 是**封闭集**，每一种都直接对应某个族的"可判"需求；新增 kind 必须走改签。
 * 断言之间是"全部满足才算 PASS"，不存在"任一条满足"的语义（那会让失败原因不可定位）。
 */
export type ScenarioExpectation =
  /**
   * 工具调用序列。`exact` = 完全相同；`prefix` = 前 N 个相同；`contains` = 按序出现即可。
   * 平均步数指标由 `exact` / `prefix` 的长度导出。
   */
  | {
      readonly kind: 'tool-sequence'
      readonly tools: readonly string[]
      readonly mode: 'exact' | 'prefix' | 'contains'
    }
  /** 期望某次调用被治理面拦下（P 族的主力断言；对应"越权拦截率"）。 */
  | {
      readonly kind: 'tool-denied'
      readonly tool: string
      /** 拒绝原因码（取值域由既有 sentry/tier 决定，W02 不新增）。 */
      readonly code: string
    }
  /** 期望工具结果里某个字段等于给定值（Q 族一致性、T 族金额）。 */
  | {
      readonly kind: 'tool-result'
      readonly tool: string
      /** 结果内的字段路径，点号分隔，如 `balance` 或 `transfer.txnId`。 */
      readonly path: string
      readonly equals: unknown
    }
  /** 期望模型整轮拒答（K 族；对应"拒答正确率"）。 */
  | {
      readonly kind: 'refused'
      /** 拒答原因码，如 `no-evidence` / `signature-invalid`。 */
      readonly reason: string
    }
  /**
   * 期望会话里出现某个事件（S 族 `COMPENSATION_DLQ`、D 族 `plan/completed`、
   * K 族签名失效事件等都在这里断言）。
   */
  | {
      readonly kind: 'event'
      /** 完整事件键，如 `tool/call`、`plan/completed`。 */
      readonly type: string
      /** 只命中载荷里这些字段相等的那些事件；缺省 = 出现即可。 */
      readonly where?: Readonly<Record<string, unknown>>
    }
  /**
   * 期望**不出现**某个事件。
   *
   * 为什么必须有：D 族 dry-run 的核心断言就是"**零 `tool/call`**"——
   * 只靠"出现了什么"无法证明"没有留下假记录"，而假记录正是 W20 演示要证明的反面。
   * 同理 K 族的"拒答后不该有 `transfer/created`"也只能用否定断言表达。
   */
  | {
      readonly kind: 'no-event'
      readonly type: string
      readonly where?: Readonly<Record<string, unknown>>
    }

/**
 * 一个场景。
 *
 * 决定性要求（W13 的 TC-W13-02）：**同 `seed` 两次跑，报告逐字段全等**。
 * 所以场景里不许出现 `Date.now()` / 随机数——时间由 runner 的固定钟提供，`seed` 只喂假随机源。
 */
export interface ScenarioSpec {
  /** 全局唯一，形如 `T-03`（族字母 + 两位序号）。唯一性由 W13 的校验器强制。 */
  readonly id: string
  readonly family: ScenarioFamily
  /** 人读标题，会进报告。一句话说清"这个场景在证什么"。 */
  readonly title: string
  /** 用哪个 profile 起应用（对应 `profiles/<name>`）。同一 (family, approval) 组合内必须一致。 */
  readonly profile: string
  /**
   * 审批应答模式（缺省 `allow`）。**取值域对齐代码实际能力，不发明第四种**：
   * - `allow`       → `responder: headless` + `autoDecision: 'allow'`
   * - `reject`      → `responder: headless` + `autoDecision: 'reject'`
   * - `unavailable` → `responder: none`（无应答者 = 拒绝，**不是超时**）
   *
   * **"审批超时"不在这里表达**：超时是票据 TTL 到期，由 `autoDelayMs` 与 TTL 组合产生，
   * 属 W13 的族内实现细节。若 P 族确实要测超时，在场景 `title` 里写明并走 ADR-0003。
   */
  readonly approval?: ScenarioApproval
  /** 固定种子。同 seed 两次跑必须全等。 */
  readonly seed: number
  /**
   * 场景自带数据集名（`packages/eval/src/scenarios/fixtures/` 下）。
   * 缺省 = 空库起步，用于"什么都没发生"的基线场景。
   */
  readonly dataset?: string
  /** 用户依次说的话，一轮一条。空数组 = 不发起任何 turn（只验启动态）。 */
  readonly turns: readonly string[]
  /** 断言全集；空数组 = 不断言（仅用于烟测）。 */
  readonly expect: readonly ScenarioExpectation[]
  /** 计入哪项指标；缺省不计数。 */
  readonly metric?: ScenarioMetric
}
