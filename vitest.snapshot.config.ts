import { defineConfig } from 'vitest/config'

import { bahSourceAlias } from './vitest.shared.ts'

/**
 * snapshot 面：会话快照的**无密钥回放**。
 *
 * 用例住在仓库根的 `snapshots/`，与 `packages/**` 的单测物理分离——
 * 回放是"验收证据"，不是包内部实现细节。
 *
 * 两端：
 * - **replay（默认，CI 用）**：只读 `snapshots/<case>/{session,llm,scenario}.json*`，不联网、不读密钥、不写文件；
 * - **record（人工）**：设 `BAH_SNAPSHOT_RECORD=1` 才录制，跑的还是同一条用例（先录再比对，保证新录的也自洽）。
 *
 * 超时给到 30s：一条用例里要起两次应用（回放 + 再次回放），慢机器上 5s 不够。
 */
export default defineConfig({
  resolve: { alias: bahSourceAlias },
  test: {
    include: ['snapshots/**/*.test.ts'],
    // `scenario.ts` 是场景（被 test 引用），不是用例文件
    exclude: ['**/node_modules/**'],
    passWithNoTests: true,
    testTimeout: 30_000,
    /**
     * 场景之间**必须串行**：每个场景都会 `boot()` 一个完整应用，而 `bank:saga-store`
     * 的 `dbPath` 是仓库级的 `sessions/saga.sqlite`（相对 cwd，不是每个场景独占）。
     * 多个场景文件并行时是**多个进程抢同一个 sqlite 文件**，随机报
     * `database is locked`——失败会在文件之间游走，看起来像"某个用例坏了"。
     * 回放本身是单机重活，串行的总耗时并不比并行差。
     */
    fileParallelism: false,
  },
})
