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
  // C2：脚本面（64 个 `verify-*.ts` / `ci.ts` / `coverage-summary.ts` 等）。
  //
  // 只开两条，且**不开** `consistent-type-assertions`：脚本的职责就是"从源码文本里
  // 抠出结构"，`as` 是它们的正常工作方式（`packages/*/src` 的禁令不适用于这里）。
  // 关掉的那条写在这里，不是漏配——门禁自身可 lint，但不假装它是产品代码。
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./tsconfig.scripts.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]
