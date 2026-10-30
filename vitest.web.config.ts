import { defineConfig } from 'vitest/config'

import { bahSourceAlias } from './vitest.shared.ts'

/**
 * web 面（施工单 01 §5）：前端交互与审批弹窗。
 *
 * 纯原生 JS（决策 D3），因此跑在 jsdom 里验证 DOM 行为与浏览器快照；
 * 用例与业务逻辑同目录（`apps/web/src/**\/*.test.js`），不引入组件库测试工具。
 */
export default defineConfig({
  resolve: { alias: bahSourceAlias },
  test: {
    // 并行策略：Windows 串行，Linux/CI 并行。
    // WHY：Windows 上并行 worker 拆卸会挂住——用例全绿但**进程不退出**（基线树同样
    // 复现，非本次合流引入），会让 `pnpm check` 的 spawnSync 步骤无限等待。
    // 串行实测 161s 正常退出；Linux 保持并行（约 23s）。两者用例集与断言口径完全相同。
    fileParallelism: process.platform !== 'win32',
    include: ['apps/web/src/**/*.test.js'],
    environment: 'jsdom',
    passWithNoTests: true,
  },
})
