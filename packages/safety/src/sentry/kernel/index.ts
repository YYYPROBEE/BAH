/**
 * sentry 内核汇总出口。
 * 包内其它模块一律从 `../kernel/index.ts` 取用，不在内核文件之间散点接线。
 *
 * 内核零领域依赖：这里只 `import { BahError } from '@bah/util'` 与 `@bah/core` 的类型，
 * 不 import `@bah/bank` / `@bah/runtime` / `@bah/interaction`，也不碰 `node:*`
 * （JSONL 落盘改为注入 sink，见 `trace.ts`）。
 *
 * **一处与 的有意偏差：源工程的 `kernel/tickets.js` 不迁移。**
 * 票据状态机的唯一属主是 `@bah/bank` 的 bank-core（`TicketStore` 的同步 CAS 核销）；
 * 在安全层再实现一份会造出**第二个核销属主**——两处各自记账，过期 / 吊销 / 重放判定必然漂移。
 * 09 的 `interaction/approval/ticket-ledger.ts` 已确立"只记账不核销"的分工，本内核同样只保留
 * `TraceLog` 的 `ticketsIssued` / `ticketsConsumed` 计数位，由接线层桥接 bank-core 的票据结果。
 */

export * from './budget.ts'
export * from './breaker.ts'
export * from './detect.ts'
export * from './normalize.ts'
export * from './pii.ts'
export * from './rules.ts'
export * from './tool-glob.ts'
export * from './trace.ts'
