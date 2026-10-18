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
    include: ['apps/web/src/**/*.test.js'],
    environment: 'jsdom',
    passWithNoTests: true,
  },
})
