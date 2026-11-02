import { defineConfig } from 'vitest/config'

import { bahSourceAlias } from './vitest.shared.ts'

/**
 * e2e 面：真实 DeepSeek API。
 *
 * **无 `DEEPSEEK_API_KEY` 时必须全部自动 skip**，绝不能让缺密钥把 CI 跑红。
 * 实现方式：没有密钥时不收集任何用例（include 置空 + passWithNoTests），
 * 而不是让用例执行到一半因 401 失败。
 *
 * 这也是本面在阶段 2 仍为「零用例」的原因：第一个真实用例要等阶段 4（模型层）+
 * 阶段 5（主循环）。**不要**把不需要密钥的进程级冒烟塞进这里——那条用例在
 * `packages/cli/src/main.smoke.test.ts`（unit 面，任何机器都能跑）。
 */
const hasApiKey = Boolean(process.env['DEEPSEEK_API_KEY'])

export default defineConfig({
  resolve: { alias: bahSourceAlias },
  test: {
    // 并行策略：Windows 串行，Linux/CI 并行。
    // WHY：Windows 上并行 worker 拆卸会挂住——用例全绿但**进程不退出**（基线树同样
    // 复现，非本次合流引入），会让 `pnpm check` 的 spawnSync 步骤无限等待。
    // 串行实测 161s 正常退出；Linux 保持并行（约 23s）。两者用例集与断言口径完全相同。
    fileParallelism: process.platform !== 'win32',
    include: hasApiKey ? ['packages/*/src/**/*.e2e.test.ts'] : [],
    passWithNoTests: true,
    // e2e 涉及真实网络，超时放宽；单测面不受影响
    testTimeout: 60_000,
  },
})
