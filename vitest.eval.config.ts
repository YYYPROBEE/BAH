import { defineConfig } from 'vitest/config'

import { bahSourceAlias } from './vitest.shared.ts'

/**
 * eval 面（W13 建立，W15 接线 CI）。
 *
 * 与主 `vitest.config.ts` **物理分开**：89 个场景会 boot 9 个完整应用，
 * 放进主用例面会让每次单测都变慢，也会让"eval 用例数"继续不可。
 *
 * 串行执行：S 族会临时替换全局编排配方；并行跑两套 eval 会互相污染。
 */
export default defineConfig({
  resolve: { alias: bahSourceAlias },
  test: {
    include: ['packages/eval/src/**/*.test.ts', 'packages/eval/tests/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: { BAH_KNOWLEDGE_KEY: 'demo-key-not-for-prod' },
  },
})
