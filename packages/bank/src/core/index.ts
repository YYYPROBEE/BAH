/**
 * @bah/bank · core（施工单 07：数据模型 / Provider seam / 票据状态机 / mock 核心）。
 *
 * 导出面：
 * - `model.ts`：九实体 + 品牌 ID + 金额换算 + 风控阈值形状
 * - `provider.ts`：`BankCoreProvider` 与请求/响应类型
 * - `ticket.ts`：票据状态机（`issued → approved → redeemed | blocked`）
 * - `mock.ts`：`MockBankCore`（内存账本）
 * - `suitability.ts`：适当性闸门（唯一规则；治理层与核心层共用）
 * - `merchant.ts`：商户品类词典（账单的叙事维度，独立于 `TxnCategory`）
 * - `time.ts`：UTC 日 / 账期口径
 */
export * from './mock.ts'
export * from './model.ts'
export * from './suitability.ts'
export * from './merchant.ts'
export * from './provider.ts'
export * from './compensation.ts'
export * from './ticket.ts'
export * from './time.ts'
export * from './verify-gateway.ts'
