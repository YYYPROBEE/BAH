import { defineConfig } from 'vitest/config'

import { COVERAGE_ALLOWLIST } from './scripts/coverage-allowlist.ts'

/**
 * 强制 100% 名单 → coverage include 模式（施工单 01 §7：CI 读取名单，
 * 不把包名写死在配置里；名单扩容时覆盖率门禁自动跟着扩容）。
 *
 * `scope` 形如 `'agent-loop/'`（包内目录）或 `'tools/tier.ts'`（单文件）：
 * 以 `.ts` 结尾视为单文件，否则视为目录前缀。
 */
const allowlistedSources = COVERAGE_ALLOWLIST.map(({ package: pkg, scope }) =>
  scope.endsWith('.ts') ? `packages/${pkg}/src/${scope}` : `packages/${pkg}/src/${scope}**/*.ts`,
)

/**
 * unit / 集成面（施工单 01 §5）。
 *
 * 覆盖纯函数内核与四接缝集成（最小 ctx 模拟器）。
 * 覆盖率只统计「强制名单」里的文件：那是"确定性组件可信"的证据，不是全仓指标
 * （施工单 00 §11：每文件 100% 只对内核与治理平面强制）。
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: allowlistedSources,
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        // api.ts 是纯类型契约（冻结面）：没有任何可执行行，统计它只会得到假的 0%
        'packages/core/src/api.ts',
      ],
      // 名单内文件的行覆盖必须 100%（按文件强制的兜底执行口）
      thresholds: { lines: 100 },
    },
  },
})
