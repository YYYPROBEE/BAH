import tseslint from 'typescript-eslint'

/**
 * 最小 lint 基线（报告 Q-M9）：
 * - 先只开三条与审查直接相关的规则，全部为 `warn`，避免一次染红全仓；
 * - 测试文件不参与类型感知规则（vitest 的异步断言大量是"故意不 await"的负控）。
 *
 * 清债完成后把 `warn` 升为 `error` 并接入 `scripts/ci.ts`。
 */
export default [
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/snapshots/**',
      '**/*.test.ts',
    ],
  },
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-assertions': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]
