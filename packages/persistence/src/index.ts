/**
 * @bah/persistence 包入口（阶段 3：持久化抽象接口 + JSONL 后端）。
 *
 * 后续：`projection/` `query/` `title/` `credentials/` `settings/` `identity/` `feedback/`
 * `migrations/`（施工单 03、12）。
 */
export * from './jsonl/index.ts'
export * from './persistence/index.ts'
