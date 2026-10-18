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
    package: 'persistence',
    scope: 'jsonl/',
    why: 'JSONL append-only 后端：分代命名与排他发布、尾截断容忍、版本拒绝（施工单 03 §1.5）',
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
    scope: 'core/ticket.ts',
    why: '票据状态机——核销唯一属主（施工单 07 §3）',
  },
]
