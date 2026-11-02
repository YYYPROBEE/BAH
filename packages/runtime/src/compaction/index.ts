/**
 * 压缩模块入口。
 *
 * 只在包内做 re-export：配置校验 / 度量 / 折叠 / 摘要 / 落账分散在
 * `types.ts` / `summarize.ts` / `apply.ts`，这样覆盖率按文件统计时不会把入口算进可执行行。
 */

export * from './apply.ts'
export * from './summarize.ts'
export * from './types.ts'
