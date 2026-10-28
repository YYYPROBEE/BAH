/**
 * `@bah/telemetry` · 遥测内核（可观测性 01）。
 *
 * 四层，互不反向依赖：
 *
 * ```text
 * ids.ts        trace/span 标识 + W3C traceparent（纯函数，确定性）
 * span.ts       TelemetrySpan 类型 + 13 个 span 名闭集 + 属性白名单
 * derive.ts     会话事件 → span（纯函数，可对历史日志离线重算）
 * recorder.ts   环形缓冲 + withSpan/withSpanAsync + 采样/淘汰
 * tree.ts       扁平 span → 森林 / 深度 / 自身耗时
 * export-*.ts   Chrome Trace / 稳定 JSON（纯函数，不读磁盘）
 * ```
 *
 * 三条纪律（违反即等于把观测做成第二个真相源）：
 *
 * 1. **本包不产生任何会话事件**——它只读事件、只在内存或独立 `span.jsonl` 里留存；
 * 2. **本包不依赖 core**——只依赖 `@bah/util`，因此 runtime / saga 都能用它，
 *    而它永远不知道有谁在用它（`verify-package-graph` 会校验这条边）；
 * 3. **本包不读时钟、不读磁盘、不用随机**——`now` 由调用方注入，
 *    否则同一份历史日志会在不同时刻算出不同的图（`verify-telemetry` 会校验）。
 */

export * from './ids.ts'
export * from './span.ts'
export * from './derive.ts'
export * from './recorder.ts'
export * from './tree.ts'
export * from './export-json.ts'
export * from './export-chrome.ts'
