/**
 * `@bah/policy` 包入口（策略外置 S1）。
 *
 * 只做 re-export（`verify-index-barrels` 按纯 barrel 校验）。
 *
 * 分层：`errors/limits/schema` → `expr/*` → `yaml/canonical` → `table` →
 * `analyze/corpus` → `compile` → `signature/load`。
 * 本包**不依赖** `runtime` / `bank` / `host`：工具目录、参数值、输入对象都由调用方注入。
 */
export * from './analyze.ts'
export * from './canonical.ts'
export * from './compile.ts'
export * from './corpus.ts'
export * from './errors.ts'
export * from './expr/check.ts'
export * from './expr/eval.ts'
export * from './expr/lexer.ts'
export * from './expr/parser.ts'
export * from './limits.ts'
export * from './load.ts'
export * from './schema.ts'
export * from './sentry-rules.ts'
export * from './signature.ts'
export * from './table.ts'
export * from './yaml.ts'
