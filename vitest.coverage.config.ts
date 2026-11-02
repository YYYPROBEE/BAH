/**
 * 全仓覆盖率口径（W17 主指标）—— **与主配置只差"分母"**。
 *
 * ## 为什么需要第二份配置
 *
 * `vitest.config.ts` 的 `coverage.include` 是**强制 100% 名单**（29 条 allowlist）：
 * 它保证"内核与治理平面逐文件 100%"，但**不是全仓指标**——分母只算了一部分源码行，
 * 数字好看却不算数（底座评审的红灯就是这个）。
 *
 * 所以这里另起一份：
 *
 * | | 主配置 `vitest.config.ts` | 本配置 |
 * |---|---|---|
 * | 分母 | allowlist 名单 | `packages/* /src/**` 全量 |
 * | 阈值 | 逐文件 100%/100%/100%/分支 80% | 由 `scripts/coverage-summary.ts` 判（行 ≥80%、包 ≥14/16） |
 * | 用途 | 守住"确定性组件可信" | 报出**全仓行口径与包口径**两个数 |
 *
 * ## 一处刻意的设计：exclude 从主配置**继承**，不复制
 *
 * 类型文件、纯 barrel、以及 8 处"预存缺口"的排除理由都写在主配置里（每条都带移除条件）。
 * 这里 import 主配置直接取 `exclude`，保证两份口径排除的是同一批文件——
 * 复制一份的话，主配置改了排除项而这里没跟，两个数就再也不能互相印证。
 */

import { defineConfig } from 'vitest/config'

import baseConfig from './vitest.config.ts'
import { bahSourceAlias } from './vitest.shared.ts'

/** 主配置（`defineConfig` 的返回值就是普通对象）。 */
interface VitestShape {
  readonly test?: {
    readonly include?: readonly string[]
    readonly exclude?: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    readonly coverage?: { readonly exclude?: readonly string[] }
  }
}

const base = (baseConfig as VitestShape).test ?? {}
const baseExclude = base.coverage?.exclude ?? []
if (baseExclude.length === 0) {
  throw new Error('vitest.coverage.config.ts: 没能从主配置读到 coverage.exclude（口径会漂，直接停）')
}

export default defineConfig({
  resolve: { alias: bahSourceAlias },
  test: {
    // 并行策略：Windows 串行，Linux/CI 并行。
    // WHY：Windows 上并行 worker 拆卸会挂住——用例全绿但**进程不退出**（基线树同样
    // 复现，非本次合流引入），会让 `pnpm check` 的 spawnSync 步骤无限等待。
    // 串行实测 161s 正常退出；Linux 保持并行（约 23s）。两者用例集与断言口径完全相同。
    fileParallelism: process.platform !== 'win32',
    include: base.include ?? ['packages/*/src/**/*.test.ts'],
    exclude: base.exclude ?? [],
    passWithNoTests: true,
    ...(base.env === undefined ? {} : { env: { ...base.env } }),
    coverage: {
      provider: 'v8',
      // ★ 唯一的区别：分母是全部源码
      include: ['packages/*/src/**/*.ts'],
      exclude: [...baseExclude],
      reporter: ['json-summary', 'text-summary'],
      reportsDirectory: '.ci-artifacts/cov-all',
      // 不清理报表目录：本机沙箱的 safe-delete 会拦 vitest 的 cleanAfterRun，
      // 让"测试全绿但退出码 1"这种假红出现。目录在 .ci-artifacts 下、每次覆盖同名文件，
      // 残留不影响读数（summary 脚本只读 coverage-summary.json）。
      clean: false,
      // 连 v8 的 .tmp 目录也不清：本机沙箱 safe-delete 会拦批量删除（350 个文件超阈值），
      // 表现为"覆盖率已算出来但退出码 1"的假红。残留 .tmp 不影响读数。
      cleanOnRerun: false,
      // 阈值刻意**不写在这里**：包口径（≥14/16）vitest 表达不了，
      // 两处判会造成"一处过一处不过、到底听谁的"。统一由 coverage-summary.ts 判。
    },
  },
})
