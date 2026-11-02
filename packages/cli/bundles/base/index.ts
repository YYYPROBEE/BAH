/**
 * bundle `base`：底座首层。
 *
 * 内容 = 内核之上的一切"每个入口都要"的插件行：会话、工具、提示词、模型、主循环、持久化。
 * 它**不写死任何渠道**：语气、模型、是否带 UI 全部由各 profile 的 patch 表达。
 *
 * 为什么这里只有数据没有代码：行引用 `use`（依赖清单里的插件实现），
 * 想换实现只需要换依赖清单或加一行 patch——bundle 文件因此永远不需要 import 运行时。
 */

import type { Bundle } from '@bah/host'

/** base bundle：所有 profile 的第一层。 */
export const bundle: Bundle = {
  name: 'base',
  rows: [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    // 生产默认：真实 provider。headless 的 patch 会把它整块换成 mock（层序演示见 docs/profile.md）
    { id: 'core:model', config: { provider: 'deepseek', model: 'deepseek-chat' } },
    { id: 'core:agent', config: { loop: { model: 'deepseek:deepseek-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions' } },
    // 观测面（obs:telemetry）：只读旁路，不产生会话事件（不改变任何快照）。
    // 排在持久化之后（要 `bah:session-files` 的落点）；config 取缺省（容量 2000、只留内存）。
    { id: 'obs:telemetry', config: { maxSpans: 2000 } },
    // 会话级证据链（W08）：工具调用 + sentry 判决 + 审批结论落 `<会话>/audit.jsonl`。
    // 排在持久化之后：链根与 `SESSION_FILES.root` 同源，`--jsonl` 换目录时一起走。
    { id: 'audit:decisions' },
    // 银行工具族：默认不带身份（会话绑定由 profile 显式写 demoUserId）；
    // headless / 演示 profile 用 patch 显式引导
    // 策略外置 S2：**必须排在 bank:tools 之前**——bank 在 apply() 里 `findPolicyEngine`，
    // 后置的行它看不到（`policy:rules.validateComposition` 会把这个顺序做成启动错误）。
    // 行本身不启用判决：`bank:tools.policy.engine` 缺省 `legacy`，行为逐字不变。
    { id: 'policy:rules' },
    { id: 'bank:tools' },
    // 审批服务：必须排在 bank:tools 之后——bank 的桥接先签五绑定票据，
    // 再把「找谁应答」交给本行的仲裁器（waterfall 的注册顺序 = 外层顺序）
    { id: 'interaction:approval' },
    // 安全防护层：也在 bank:tools 之后（要 bank:ticket-guard 做熔断吊销）；
    // 只做四接缝接线 + 幻觉防护，判决阈值全部走 safety:sentry 配置
    { id: 'safety:sentry' },
    // W05 断言核验门：回复落账前逐条核验高影响断言（金额/余额/费率/日期/账号尾号）。
    // 排在最前的好处见 `packages/host/src/boot/plugins/verify.ts` 的模块注释：
    // waterfall 的注册顺序 = 外层顺序，核验门在外层才能看到下游改写后的文本。
    { id: 'safety:verify' },
    // 沙箱执行：给 analysis_calc 提供 `bank:compute` seam（worker + 硬杀）
    { id: 'safety:sandbox' },
    // Saga 补偿与审计层（SA-07）：存储底座 → 协调器（提供时钟）→ 审计链（等时钟就绪）
    // dbPath 缺省 = 会话根下的 saga.sqlite（随 --jsonl / demo 独立目录一起走）
    { id: 'bank:saga-store' },
    { id: 'bank:saga' },
    { id: 'bank:saga-audit' },
    // 意图平面与追问：两个内置绿级工具，零新事件键（落账走 tool/call + tool/result）。
    // 排在 core:tools 之后（注册工具要求工具面就绪）；两行顺序固定：prompt:ask 取 intent:plane 的状态。
    // 记忆未装配时用插件配置里的确定性夹具（生产 profile 不写），见 plugins/intent.ts 的「诚实边界」。
    { id: 'intent:plane' },
    { id: 'prompt:ask' },
    // 接线层：把"写工具"接进协调器。
    // - `maxAttempts: 1` 是安全约束，不是保守：幂等键没传给银行核心，重试 = 真的多扣一次钱
    // - `tickIntervalMs: 60000` 给收敛 job 一个发射点（无发射者时三个 job 永不执行）
    // - 关掉只需把 `enabled` 改 false
    {
      id: 'bank:saga-bridge',
      config: {
        enabled: true,
        eligible: ['transfer_create'],
        tickIntervalMs: 60_000,
        saga: { maxAttempts: 1 },
      },
    },
  ],
}
