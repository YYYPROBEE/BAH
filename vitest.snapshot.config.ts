import { defineConfig } from 'vitest/config'

/**
 * snapshot 面（施工单 01 §5 / 施工单 12）：录制会话的无密钥回放。
 *
 * 用例住在仓库根的 `snapshots/`，与 `packages/**` 的单测物理分离——
 * 回放是"验收证据"，不是包内部实现细节。
 */
export default defineConfig({
  test: {
    include: ['snapshots/**/*.test.ts'],
    passWithNoTests: true,
  },
})
