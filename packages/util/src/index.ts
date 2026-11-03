/**
 * @bah/util 包入口（M0，阶段 1）。
 *
 * 逻辑模块子目录：brand、util、jsonl、random。
 * 本包只承载"零依赖、无领域语义"的原语；任何业务概念都不许进这里。
 *
 * 例外（租户与鉴权 01 §2.1–§2.2）：`tenant.ts` / `principal.ts` 是**跨包品牌类型**
 * 与"角色固定序"的唯一定义处。它们必须被 host / bank / persistence 共用，
 * 放 runtime 会形成反向依赖（runtime 不能依赖 host），所以落在 util。
 */
export * from './brand/index.ts'
export * from './jsonl/index.ts'
export * from './logging.ts'
export * from './principal.ts'
export * from './random/index.ts'
export * from './tenant.ts'
export * from './tool-contract.ts'
export * from './tool-contract-validate.ts'
export * from './util/index.ts'
