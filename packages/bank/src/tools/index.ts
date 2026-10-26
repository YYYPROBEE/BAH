/**
 * @bah/bank · tools（施工单 08：银行工具族）。
 *
 * 导出面按用途收口：
 * - `specs.ts` / `render.ts`：目录与文档生成（门禁读这一层，不装配 Provider）；
 * - `catalog.ts`：`createBankTools(deps)`；
 * - `governance.ts`：pre-execute 判决 + 审批票据桥接；
 * - `dto.ts` / `presenters.ts`：渠道卡片契约；
 * - `events.ts`：领域 durable 事件。
 */

export * from './account-ops.ts'
export * from './catalog.ts'
export * from './compute.ts'
export * from './dto.ts'
export * from './events.ts'
export * from './governance.ts'
export * from './identity.ts'
export * from './presenters.ts'
export * from './policy.ts'
export * from './render.ts'
export * from './result-schemas.ts'
export * from './specs.ts'
export * from './tier.ts'
export * from './types.ts'
