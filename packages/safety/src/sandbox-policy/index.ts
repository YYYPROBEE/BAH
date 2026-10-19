/**
 * `@bah/safety` 的 sandbox 模块出口（施工单 11）。
 *
 * 两半的分工：`sandbox-policy` 只回答"这一调用进哪一档"，`sandbox-runtime` 只回答
 * "在什么环境里执行、执行成什么样"。判决与执行分家，才谈得上"阻断只由确定性组件执行"。
 */

export * from './policy.ts'
export * from './tier.ts'
