import { defineConfig } from 'vitest/config'

/**
 * e2e 面（施工单 01 §5）：真实 DeepSeek API。
 *
 * **无 `DEEPSEEK_API_KEY` 时必须全部自动 skip**，绝不能让缺密钥把 CI 跑红。
 * 实现方式：没有密钥时不收集任何用例（include 置空 + passWithNoTests），
 * 而不是让用例执行到一半因 401 失败。
 */
const hasApiKey = Boolean(process.env['DEEPSEEK_API_KEY'])

export default defineConfig({
  test: {
    include: hasApiKey ? ['packages/*/src/**/*.e2e.test.ts'] : [],
    passWithNoTests: true,
    // e2e 涉及真实网络，超时放宽；单测面不受影响
    testTimeout: 60_000,
  },
})
