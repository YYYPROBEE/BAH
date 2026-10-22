/**
 * `@bah/interaction` · approval（施工单 09 §2–§3）。
 *
 * 公开面：
 * - `ApprovalService`：`approval/request` 的唯一仲裁点（应答者 / 超时 / 归一化 / 幂等）；
 * - `TicketLedger`：票据生命周期账本（每次转移落 `ticket/*` 事件，核销属主仍是 bank-core）；
 * - `createHeadlessResponder`：只在显式配置开启时注册的自动应答者；
 * - `events.ts`：本包声明的 durable 领域事件（`ticket/*`、`approval/*`）。
 */

export * from './events.ts'
export * from './headless-responder.ts'
export * from './service.ts'
export * from './ticket-ledger.ts'
export * from './types.ts'
