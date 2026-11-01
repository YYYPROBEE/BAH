/**
 * `@bah/safety` · 逻辑模块 sentry。
 *
 * 两层：
 * - `kernel/`：零领域依赖的内核八件（归一化 / 检测 / 规则 / 代币化 / 预算 / 断路器 / TraceLog / 通配符）——
 *   **算法与阈值不做任何改动**；
 * - `pipeline/`：四接缝接线（ingress / control / ticketing / audit）、注入防御矩阵、
 *   幻觉防护与熔断锁存的落点。
 *
 * 对外入口只有本文件；包内其它模块从 `../kernel/index.ts` 或 `../pipeline/index.ts` 取用。
 */

export * from './halt.ts'
export * from './kernel/index.ts'
export * from './pipeline/index.ts'
