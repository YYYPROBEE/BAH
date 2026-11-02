/**
 * @bah/test-support 包入口。
 *
 * 逻辑模块：`mock-ctx`、`session-snapshot`、`llm-mock-server`；
 * 另有测试地基需要的 `fixtures`（确定性夹具）与 `assertions`（结构化错误断言）。
 *
 * 依赖方向：`test-support → core / util`（阶段 2 追加；原表未列该包，见）。
 * 本包只服务测试，**不得**被任何运行时包依赖。
 */
export * from './assertions/index.ts'
export * from './fixtures/index.ts'
export * from './llm-mock-server/index.ts'
export * from './mock-ctx/index.ts'
export * from './session-snapshot/index.ts'
