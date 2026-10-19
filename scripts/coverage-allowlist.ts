/**
 * 覆盖率强制名单（施工单 01 §7）。
 *
 * **按文件 100% 行覆盖强制**——这是"确定性组件可信"的证据，不是全仓指标。
 * 覆盖率门槛不能全局 100%（那会逼人给测试专用代码写无意义测试），
 * 所以只在下面这些"判决与副作用密集"的文件上强制。
 *
 * CI 读取本名单；名单扩容属正常演进，缩容需要理由。
 */

/** 一个强制项：包名 + 包内路径前缀（相对 `packages/<dir>/src/`）。 */
export interface CoverageAllowlistEntry {
  /** 物理包目录名（`packages/<dir>`）。 */
  readonly package: string
  /** 包内源码路径前缀；`''` 表示该包全部源文件。 */
  readonly scope: string
  /** 为什么强制 100%。 */
  readonly why: string
}

export const COVERAGE_ALLOWLIST: readonly CoverageAllowlistEntry[] = [
  {
    package: 'core',
    scope: '',
    why: '内核：五模式派发、生命周期、inject/waiting 队列、config fail-loud（施工单 02）',
  },
  {
    package: 'runtime',
    scope: 'agent-loop/',
    why: '主循环：turn/step 状态机、失败补记、max-tokens 粘性（施工单 04）',
  },
  {
    package: 'runtime',
    scope: 'tools/',
    why: '工具七段管线与判决顺序——顺序错了就是安全事故（施工单 03）',
  },
  {
    package: 'runtime',
    scope: 'session/',
    why: '会话 append-only 日志与 deriveMessages 投影（施工单 03）',
  },
  {
    package: 'runtime',
    scope: 'system-prompt/',
    why: '系统提示词六段装配、能力位裁剪、运行时上下文 reconcile（施工单 05 §4）',
  },
  {
    package: 'runtime',
    scope: 'compaction/',
    why: '上下文压缩：阈值判定、结构化摘要、金融字段保留、折叠投影（施工单 05 §5）',
  },
  {
    package: 'llm',
    scope: '',
    why: '模型适配层：分片装配（参数整体 parse）、参数三级防线、降级链、成本账本（施工单 05 §1–§3）',
  },
  {
    package: 'persistence',
    scope: 'jsonl/',
    why: 'JSONL append-only 后端：分代命名与排他发布、尾截断容忍、版本拒绝（施工单 03 §1.5）',
  },
  {
    package: 'host',
    scope: 'boot/',
    why: '组合系统：四层层序与整块替换、fail-loud 校验、boot 装配与回滚、config-only HMR（施工单 06）',
  },
  {
    package: 'host',
    scope: 'plugin-manager/',
    why: '依赖清单与逐行配置校验：未知插件 / 重复挂载 / 默认值兜底（施工单 06 §2、§4）',
  },
  {
    package: 'cli',
    scope: 'cli/',
    why: 'CLI 入口面：参数解析、退出码语义（0/1/2）、headless 运行与 config HMR 接线（施工单 06）',
  },
  {
    package: 'cli',
    scope: 'profile.ts',
    why: 'profile / patch 文件解析与四层层序的 fail-loud 校验（施工单 06 §4）',
  },
  {
    package: 'cli',
    scope: 'bundles.ts',
    why: 'bundle 发现与依赖清单校验（施工单 06 §2：bah.profile.bundles）',
  },
  {
    package: 'cli',
    scope: 'dump-config.ts',
    why: '生效树与来源层标注——答辩材料与"任何一行可被替换"的证据面（施工单 06 §4）',
  },
  {
    package: 'safety',
    scope: 'sentry/',
    why: '判决 / 归一化 / 规则 / 票据 / 断路器（施工单 10）',
  },
  {
    package: 'bank',
    scope: 'tools/tier.ts',
    why: '三级权限判定矩阵（施工单 09）',
  },
  {
    package: 'bank',
    scope: 'tools/governance.ts',
    why: '治理平面：pre-execute 判决落账 / 五绑定票据桥接 / 结果记账（施工单 09 §1–§3）',
  },
  {
    package: 'interaction',
    scope: 'approval/',
    why: '审批服务（应答者 / 超时 / 双渠道竞答 / 挑战链）与票据生命周期账本（施工单 09 §2–§3）',
  },
  {
    package: 'bank',
    scope: 'core/',
    why: '仿真银行核心：九实体 / 票据状态机与原子核销 / 日累计权威口径 / mock 账本（施工单 07）',
  },
  {
    package: 'bank',
    scope: 'forge/',
    why: '造数确定性（seeded 三档）与风控预检五规则（施工单 07 §4）',
  },
]
