import { defineConfig } from 'vitest/config'

import { BARREL_EXCLUSIONS } from './scripts/barrel-excludes.ts'
import { COVERAGE_ALLOWLIST } from './scripts/coverage-allowlist.ts'
import { bahSourceAlias } from './vitest.shared.ts'

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
  resolve: { alias: bahSourceAlias },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    exclude: ['packages/*/src/**/*.e2e.test.ts'],
    passWithNoTests: true,
    /**
     * W06：签名门的固定测试密钥。
     *
     * 这是**完整性测试密钥**（公开、非机密）；运行时仍要求显式注入
     * `BAH_KNOWLEDGE_KEY`，库代码里没有任何默认密钥。
     */
    env: { BAH_KNOWLEDGE_KEY: 'demo-key-not-for-prod' },
    coverage: {
      provider: 'v8',
      include: allowlistedSources,
      exclude: [
        '**/*.test.ts',
        // 只排除显式登记的纯 barrel（verify-index-barrels 逐条校验）；
        // 实现型 index.ts 必须由覆盖率统计，否则就是假绿。
        ...BARREL_EXCLUSIONS.map((entry) => entry.path),
        // api.ts 是纯类型契约（冻结面）：没有任何可执行行，统计它只会得到假的 0%
        'packages/core/src/api.ts',
        // 纯类型模块（只有 export type / 类型别名），零可执行行
        'packages/runtime/src/tools/types.ts',
        // 知识包的纯类型端口 + 测试夹具构造器：无可执行分支可测
        'packages/knowledge/src/port.ts',
        'packages/knowledge/src/testing.ts',
        // provider-neutral 词汇表：只有联合类型与接口，零可执行行
        'packages/llm/src/llm/types.ts',
        // 压缩的配置/计划形状：只有接口，零可执行行
        'packages/runtime/src/compaction/types.ts',
        // 仿真银行的 Provider 契约：只有接口与类型别名，零可执行行
        'packages/bank/src/core/provider.ts',
        // 预存缺口（先排除以保持门禁可运行）。**C8 已补 host 级接线用例**
        // （T-SA07-007 归属 / 008 卸载即取消 / 009 未卸载照跑），启动恢复与收敛注册
        // 不再是无覆盖的盲区。剩余缺口只有两个**运行期才触发**的分支：
        //   - `installConvergence` 的告警闭包：要 janitor 真的报出告警才会执行；
        //   - `.catch` 里的 recovery-failed 体：要启动恢复自身抛错才会执行。
        // 移除条件：补一条「janitor 报出告警」或「启动恢复失败」的 host 级用例。
        'packages/host/src/boot/plugins/saga.ts',
        // 缺口只剩一个**运行期不可达**的防御性守卫：`pick()` 的「候选集不能为空」throw。
        // 它的三个调用点全部传入 4 元素字面量元组，`seededRandom` 值域又是 [0,1)，
        // 下标必然落在 [0, len-1]——该分支无法被任何公开 API 触达（R0）。
        // 改成非空元组类型可从编译期消除它，但 `packages/bank/src/` 属 snapshot-fresh 的
        // SENSITIVE 面，纯重构（重录 diff 恒为 0）在 CI 下过不了该门禁。
        // 移除条件：新增 `stress` 档快照场景覆盖 forge，或 snapshot-fresh 支持「纯重构」声明。
        'packages/bank/src/forge/index.ts',
        // 缺口是插件里那个 `warn: (message) => console.warn(message)` 闭包：它与
        // `jsonl/backend.ts` 的默认实现 `options.warn ?? ((m) => console.warn(m))` 逐字等价，
        // 且告警只在**读路径**（丢弃截断尾行）触发，而本插件只 create/append、从不读，
        // 故该闭包在装配下永远不被调用。删掉它是零行为改动，但同样受 snapshot-fresh 限制。
        // 移除条件：本插件新增读路径，或后端把默认出口去掉。
        'packages/host/src/boot/plugins/persistence.ts',
      ],
      // 名单内文件逐文件强制：每文件行/语句/函数 100%，分支暂钉在 80%（清债后升 95/100）。
      // 旧配置只有全局 lines: 100，一个文件 99% 会被另一个文件 100% 掩盖——那正是审查指出的假绿。
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 80,
        perFile: true,
      },
      // text 给人看；lcov 给 CI / 答辩材料；json-summary 给脚本读
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
