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
    package: 'policy',
    scope: '',
    why: '策略编译器与求值器：类型检查、静态分析、内容寻址——判决语义的唯一定义处（策略外置 S1）',
  },
  {
    package: 'runtime',
    scope: 'intent/',
    why: '意图平面：规则序、整数评分、0.6 拒借闸门、金额单位与 PII 脱敏——每一条未覆盖分支都可能是「猜」的藏身处（03 单）',
  },
  {
    package: 'interaction',
    scope: 'prompt/',
    why: '追问候选：去重/确定性排序/上限 3/恒含手动出口/空候选 fail-loud 与防死循环上限（03 单）',
  },
  {
    package: 'runtime',
    scope: 'goal/',
    why: '意图账本：状态转移表（非法转移 fail-loud）、active 上限、重放重建——账本说谎比崩溃更贵（04 单）',
  },
  {
    package: 'runtime',
    scope: 'todo/',
    why: '派生清单：复用 replayPlan 的同源同序、中断窗口的 cancelled 镜像、全量覆写与上限（04 单）',
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
    package: 'persistence',
    scope: 'chain/audit-report.ts',
    why: '审计只读面：链连续性、签名覆盖与签名四态（施工单 16 §10）',
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
    package: 'safety',
    scope: 'sandbox-policy/',
    why: '沙箱档位解析：三层覆盖序 / 模型代码禁入 none / override 只收紧（施工单 11 §2）',
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
    why: '造数确定性（seeded 三档）与风控预检规则（施工单 07 §4）',
  },
  {
    package: 'saga',
    scope: 'state-machine/',
    why: 'saga 状态机：唯一转移函数 / 非法出边 / 未知事件 fail-loud（资金补偿状态不可静默失真）',
  },
  {
    package: 'saga',
    scope: 'coordinator/commit.ts',
    why: '单提交段：sqlite 业务写 + 审计 fsync + COMMIT 的顺序不变量（SA-08）',
  },
  {
    package: 'saga',
    scope: 'alert/sink.ts',
    why: '告警出口扇出：单 sink 失败不得阻断后续（观测链路）',
  },
  {
    package: 'saga',
    scope: 'probe/classify.ts',
    why: '补偿探诊分类：未知/成功/失败三态分类错误会导致重复补偿或漏补偿',
  },
  {
    package: 'saga',
    scope: 'view/causality.ts',
    why: '因果视图：审计链回放的顺序判定（错序会让补偿方向反转）',
  },
  {
    package: 'knowledge',
    scope: '',
    why: '知识平面适配层：principal 组装 / 契约守卫 / 超时降级 / 工具与卡片（防 ACL 越权与静默放行）',
  },
  {
    package: 'channels',
    scope: 'capabilities.ts',
    why: '能力位单一实现点：6 渠道穷尽与 10 字段是对外口径，错一个字段前端就降级错（施工单 01 / 00 D4）',
  },
  {
    package: 'channels',
    scope: 'http-adapter.ts',
    why: 'web 与 mobile 共用的审批翻译层：归属校验、六码判决、理由长度上限——顺序错了就是资金事故（施工单 01 / 00 D2）',
  },
  {
    package: 'channels',
    scope: 'mobile/',
    why: '移动渠道薄工厂：能力位与 id 的唯一落点（施工单 01）',
  },
  {
    package: 'channels',
    scope: 'im/',
    why: 'IM 渠道内核：平台契约 / 会话键 / 帧投影 / 指令解析——每一条都是网关与审批的前置判决，错一个就是越权或误批（IM 网关 01）',
  },
]
