/**
 * `@bah/llm` 包入口（阶段 4：模型层实装）。
 *
 * 导出面：
 * - `.`（本入口）：词汇表 + Adapter seam + 装配 + 参数修复 + 成本账本 + 降级链
 * - `./mock`：脚本化确定性 provider（无密钥跑通完整 turn）
 * - `./deepseek`：DeepSeek provider（真实流式）
 *
 * 跨包纪律：其他包只 import 包名，不 import `src/`。
 */

export * from './llm/index.ts'
