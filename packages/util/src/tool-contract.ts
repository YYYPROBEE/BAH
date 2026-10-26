/**
 * 工具契约（G-1）的**形状**，不含任何校验实现（W02 三件冻结之一）。
 *
 * 为什么这里一行运行时代码都没有：
 * 本文件是契约的形状声明，任何 `const` / `function` 都会在构建产物里生成 chunk，
 * 而 TC-W02-01 / TC-W02-02 要求"类型文件不产生运行时代码"。
 * 校验逻辑在 W03（`packages/runtime/src/tools/` 侧）实现，本文件只负责"长什么样"。
 *
 * 为什么 schema 位置留成泛型、而不是直接写 `ToolSchema`：
 * `@bah/core` 的 `package.json` 依赖 `@bah/util`（实测），所以 `@bah/util` **不能** import `@bah/core`
 * —— 那会形成包级环。而真实的 schema 类型 `ToolSchema` / `ToolJsonSchema` 只有 core 有。
 * 因此这里把两个 schema 位置留成泛型，由使用方代入：
 * `ToolContract<ToolSchema, ToolSchema>`（`@bah/bank` 声明处就是这样用的）。
 * 好处：形状只有一份、不复制 core 的类型（避免第二真相源），类型仍然收得紧。
 */

/**
 * 契约校验的挂载时点。
 *
 * `pre-execute`：在 `tools/pre-execute` 判定链上校验（能看到票据与三级判定结论）。
 * `post-execute`：在工具体返回之后、结果落账之前校验。
 */
export type ContractStage = 'pre-execute' | 'post-execute'

/**
 * 一个工具的完整契约。
 *
 * `validateAt` 的语义（本单冻结，见 `docs/contracts/tool-contract.md` §2.3）：
 * 它只描述**入参**的校验时机；**出参校验恒定在 `post-execute`**
 * —— 入参在工具体跑之前就该拦住，出参只可能在跑完之后才有。
 * 单一字段无法表达两个时点，这是 W02 冻结时留下的已知窄口，
 * 若 W03 需要分别配置，走 ADR-0003 扩展（不要直接加字段）。
 *
 * @typeParam ArgsSchema - 入参 schema 的类型（使用方代入 `ToolSchema`）
 * @typeParam ResultSchema - 出参 schema 的类型（使用方代入 `ToolSchema`）
 */
export interface ToolContract<ArgsSchema = unknown, ResultSchema = unknown> {
  /** 入参 JSON Schema。与 `ToolDefinition.schema` 的关系见 docs/contracts/tool-contract.md §2.1。 */
  readonly argsSchema: ArgsSchema
  /** 出参 JSON Schema。**不挂在 `@bah/core` 的 `ToolDefinition` 上**（宪法 R-1），挂在 `BankToolSpec`。 */
  readonly resultSchema: ResultSchema
  /** 入参校验时点；出参恒为 `post-execute`。 */
  readonly validateAt: ContractStage
}

/**
 * 校验失败时**唯一的**错误形状。
 *
 * 为什么要冻结这个：`verify-single-error-normalization` 门禁要求全仓错误只有一种归一化形状；
 * 若每个工具自己拼错误对象，W03 的"16 工具 × 故意错形状 → 全红"就无法用同一套断言判。
 *
 * 注意：这里只声明**数据形状**，不声明抛出方式（抛/返由 W03 定）。
 */
export interface ToolContractViolation {
  /** 出问题的是哪一段：入参还是出参。 */
  readonly phase: 'args' | 'result'
  /** 出问题的字段路径（JSON Pointer 风格，如 `/amount`）；整体失败时为空串。 */
  readonly path: string
  /** 机器可读原因码（W03 定义取值域；此处只要求非空）。 */
  readonly code: string
  /** 人读说明。**不得包含入参原文**（PII 纪律，宪法 §4）。 */
  readonly detail: string
}
