import { defineConfig } from 'vitest/config'

import { bahSourceAlias } from './vitest.shared.ts'

/**
 * snapshot 面（施工单 01 §5 / 施工单 12）：录制会话的无密钥回放。
 *
 * 用例住在仓库根的 `snapshots/`，与 `packages/**` 的单测物理分离——
 * 回放是"验收证据"，不是包内部实现细节。
 *
 * 现状：record / replay harness 属阶段 7（施工单 12 §4 第 4 步），
 * 本面先跑 `fixtures.test.ts`（fixture 命名与代次选择），保证通道与解析都通。
 */
export default defineConfig({
  resolve: { alias: bahSourceAlias },
  test: {
    include: ['snapshots/**/*.test.ts'],
    passWithNoTests: true,
  },
})
