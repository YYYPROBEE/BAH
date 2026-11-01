/**
 * @bah/safety 包入口。
 *
 * 逻辑模块子目录：
 * - `sandbox-policy/`、`sandbox-runtime/` 已由 落地（档位解析 + worker 执行）；
 * - `sentry/` 由 落地：内核八件 + 四接缝接线（批次 A / B）。
 *
 * 纪律：本包**不含银行领域知识**——档位、规则、预算都来自 Config 与登记，
 * 领域语义（工具、金额、票据）仍归 `@bah/bank` 与 `@bah/interaction`。
 */

export * from './sandbox-policy/index.ts'
export * from './sandbox-runtime/index.ts'
export * from './sentry/index.ts'
// W05：断言核验门（纯函数；宿主装配在 `safety:verify`）
export * from './verify/index.ts'
