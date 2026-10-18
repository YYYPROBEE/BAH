import { defineConfig } from 'vitest/config'

/**
 * unit / 集成面（施工单 01 §5）。
 *
 * 覆盖纯函数内核与四接缝集成（最小 ctx 模拟器）。M0 阶段测试集为空，
 * 用 `passWithNoTests` 保证"管线必须通"（施工单 01 §0 出口标准第 1 条）。
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      // 全局阈值只是兜底；按文件 100% 的强制名单见 scripts/coverage-allowlist.ts（施工单 01 §7）
      thresholds: { lines: 100 },
    },
  },
})
