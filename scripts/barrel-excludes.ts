/**
 * 覆盖率排除的**纯 barrel** 白名单（BAH 代码修改清单 2026-10-20 · B1.1）。
 *
 * 为什么需要显式名单：旧配置用 `**\/index.ts` 全局排除，把实现文件也一起排除了
 * （`saga/state-machine/index.ts`、`bank/forge/index.ts`、`host/plugin-manager/index.ts`、
 * `safety/sentry/pipeline/index.ts` 都有真实逻辑），覆盖率因此长期假绿。
 *
 * 纪律：
 * - 只有**只做 re-export** 的 `index.ts` 才能进本名单；
 * - 由 `verify-index-barrels.ts` 逐条校验：文件存在、路径以 `index.ts` 结尾、
 *   不含任何实现语句；名单写错/目录改名会让门禁直接红；
 * - 不在此名单里的 `index.ts` 一律进入覆盖率统计。
 */

export interface BarrelExclusion {
  /** 相对仓库根的 posix 路径。 */
  readonly path: string
  /** 为什么它是纯 barrel（给评审看的，不是装饰）。 */
  readonly why: string
}

export const BARREL_EXCLUSIONS: readonly BarrelExclusion[] = [
  {
    path: 'packages/bank/src/core/index.ts',
    why: '仿真银行核心入口：只 re-export 账户/账本/票据/时间等实现文件',
  },
  {
    path: 'packages/core/src/index.ts',
    why: '内核包入口：只 re-export api/context/events/plugin/scope/service 的实现',
  },
  {
    path: 'packages/cli/src/cli/index.ts',
    why: 'CLI 逻辑模块入口：只 re-export 参数解析与装配实现',
  },
  {
    path: 'packages/host/src/boot/index.ts',
    why: 'boot 逻辑模块入口：只 re-export boot/config/hmr/plugins 的实现',
  },
  {
    path: 'packages/interaction/src/approval/index.ts',
    why: '审批模块入口：只 re-export 应答者/票据生命周期实现',
  },
  {
    path: 'packages/knowledge/src/index.ts',
    why: '知识包入口：只 re-export port/client/tools/contract',
  },
  {
    path: 'packages/llm/src/deepseek/index.ts',
    why: 'DeepSeek provider 入口：只 re-export adapter 工厂与配置',
  },
  {
    path: 'packages/llm/src/index.ts',
    why: '模型层包入口：只 re-export llm 子模块',
  },
  {
    path: 'packages/llm/src/llm/index.ts',
    why: '模型层逻辑模块入口：只 re-export route/repair/fallback 等实现',
  },
  {
    path: 'packages/llm/src/mock/index.ts',
    why: '脚本化 provider 入口：只 re-export mock 实现',
  },
  {
    path: 'packages/persistence/src/jsonl/index.ts',
    why: 'JSONL 后端入口：只 re-export 分代/发布/读取实现',
  },
  {
    path: 'packages/policy/src/index.ts',
    why: '策略包入口：只 re-export 编译器/求值器/语料的实现文件（策略外置 S1）',
  },
  {
    path: 'packages/runtime/src/agent-loop/index.ts',
    why: '主循环模块入口：只 re-export agent/config/request/tool-calls 实现',
  },
  {
    path: 'packages/runtime/src/compaction/index.ts',
    why: '压缩模块入口：只 re-export 计划/summarize 实现',
  },
  {
    path: 'packages/runtime/src/session/index.ts',
    why: '会话模块入口：只 re-export buffer/derive/service/types 实现',
  },
  {
    path: 'packages/safety/src/sandbox-policy/index.ts',
    why: '沙箱策略模块入口：只 re-export policy/tier 实现',
  },
  {
    path: 'packages/safety/src/sentry/index.ts',
    why: 'sentry 模块入口：只 re-export kernel 与 pipeline',
  },
  {
    path: 'packages/safety/src/sentry/kernel/index.ts',
    why: 'sentry 内核入口：只 re-export 归一化/检测/规则/断路器实现',
  },
]
