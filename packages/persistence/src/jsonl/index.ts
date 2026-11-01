/**
 * JSONL 后端入口。
 *
 * 实现放在 `backend.ts`：根配置把「入口文件」（以 index.ts 结尾的那些）排除出覆盖率统计，
 * 所以逻辑不能写在入口里（否则会绕开 100% 行覆盖门禁）。
 */
export * from './backend.ts'
export * from './redact.ts'
