import { defineConfig } from 'vitest/config'

/**
 * 评测包自己的测试面（`pnpm -F @bah/eval test`）。
 *
 * 与根 `vitest.config.ts` 的关系：根配置的 include 是 `packages/*\/src/**\/*.test.ts`，
 * 不含 `tests/`——本包的用例按 M0 §4 骨架落在 `tests/`，因此必须自带一份配置，
 * 不能靠根配置扫到。这条差异已登记在 M0 汇报的偏差列表里（M2 做 CI 集成时统一）。
 *
 * 编译器别名不需要：本包**零 workspace 依赖**，adapters 用结构化 port 做鸭子类型，
 * 不 import `@bah/*` 任何包，规避了「测试面跑构建产物」的老问题。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // 纯 barrel：只有 re-export，没有可执行分支。
        'src/index.ts',
        // 纯类型模块：只有 interface / type，零可执行行。
        'src/types.ts',
        'src/adapters/ports.ts',
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
