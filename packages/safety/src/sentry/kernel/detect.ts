/**
 * 入口平面·检测器（规则通道）——施工单 10 §3 的内核组件 2：`detect`。
 * 对应源文件 `sentry-dsh-plugin/src/kernel/detect.js`——签名表、权重、加成量与阈值
 * 全部照搬（施工单 10 禁止迁移时调参）。
 *
 * 铁律一（检测器永不阻断）：本模块只输出风险信号（low/warn/high），不产生任何阻断决策；
 * 阻断由工具面的确定性组件执行（rules / budget / breaker）。高置信签名 + 顺序无关匹配 +
 * 多重命中加成，全部为纯函数、零依赖、确定性输出。
 */

import { assertNever } from '@bah/util'

/** 三族攻击族谱标签（封闭集合：新增签名族必须同步扩到这里，编译器会逼着改完）。 */
export type AttackFamily =
  | 'injection_direct'
  | 'injection_roleplay'
  | 'privacy_systemprompt'
  | 'privacy_enumerate'
  | 'privilege_escalation'
  | 'destructive_command'
  | 'privacy_pii'
  | 'privacy_debug'
  | 'code_exec'

/** 风险分级（高危只升级审计，不阻断——P3）。 */
export type RiskLevel = 'low' | 'warn' | 'high'

/** 一条检测签名：`[正则, 权重, 攻击族标签]`。 */
export type DetectorRule = readonly [pattern: RegExp, weight: number, family: AttackFamily]

/** 分级阈值（缺省取 `DETECTOR_DEFAULTS`）。 */
export interface DetectorThresholds {
  /** warn 下限。 */
  readonly warnThreshold?: number
  /** high 下限。 */
  readonly highThreshold?: number
}

/** `detect()` 的输出：风险信号（不含任何处置决策）。 */
export interface RiskSignal {
  /** 命中签名里的最大权重，多重命中时加成。 */
  score: number
  /** 命中的攻击族（可重复，顺序 = 签名表顺序）。 */
  families: AttackFamily[]
  /** 命中片段（每条截断到 40 字符，供审计回看）。 */
  signatures: string[]
  /** 分级结果。 */
  level: RiskLevel
}

/**
 * 三族高置信签名（攻击族谱：直接注入 / 权限越权诱导 / 隐私套取）。
 */
export const DETECTOR_RULES: readonly DetectorRule[] = [
  // A 族：直接注入
  [/(忽略|无视| disreg?ard |忘记|忘记掉)(之前|以上|先前|前面)?(的)?(所有)?(指令|提示|约束|设定|规则)/i,
    0.85, 'injection_direct'],
  [/(你现在是|从现在起你是|pretend to be|act as)\s*(DAN|开发者模式|developer mode|root|管理员)/i,
    0.85, 'injection_roleplay'],
  // 顺序无关：同时覆盖"系统提示词…打印"与"打印…系统提示词"两种语序
  [/(system\s*prompt|系统提示词|你的内部指令|你的初始设定|你的工作原则).{0,20}(打印|输出|复述|显示|泄露|告诉我)|(打印|输出|复述|显示|泄露|给我看|告诉我).{0,20}(system\s*prompt|系统提示词|初始指令|初始设定|工作原则)/i,
    0.80, 'privacy_systemprompt'],
  [/(你有哪些|列出你的)(工具|插件|api|数据库|数据源|权限)/i,
    0.60, 'privacy_enumerate'],
  // B 族：权限越权诱导
  [/(调用|使用|执行)(受限|未授权|admin|管理员|root|提权|越权)/i,
    0.80, 'privilege_escalation'],
  [/(sudo|chmod\s+777|rm\s+-rf|format\s+c:|del\s+\/[fqs])/i,
    0.90, 'destructive_command'],
  // C 族：隐私套取
  [/(身份证号|手机号|银行卡|密码|口令|salary|薪资).{0,12}(是多少|告诉我|列出来|导出|发给我)/i,
    0.80, 'privacy_pii'],
  [/(为了|帮)(调试|排查|测试|验证).{0,20}(打印|输出|贴出)(上下文|context|对话历史|系统消息)/i,
    0.75, 'privacy_debug'],
  [/(exec|eval|os\.system|subprocess|base64\.b64decode)\s*\(/i,
    0.70, 'code_exec'],
]

/** 检测阈值默认值（R1：泛化优先——保守阈值，宁低召回不升高误报）。 */
export const DETECTOR_DEFAULTS: Readonly<Required<DetectorThresholds>> = {
  warnThreshold: 0.45,
  highThreshold: 0.8,
}

/**
 * 规则通道检测（确定性，零概率成分）。
 *
 * @param text - 已归一化或原始文本。
 * @param thresholds - 分级阈值（省略项回落 `DETECTOR_DEFAULTS`）。
 * @returns 风险信号。
 */
export function detect(text: string, thresholds: DetectorThresholds = {}): RiskSignal {
  const warnThreshold = thresholds.warnThreshold ?? DETECTOR_DEFAULTS.warnThreshold
  const highThreshold = thresholds.highThreshold ?? DETECTOR_DEFAULTS.highThreshold
  const signal: RiskSignal = { score: 0, families: [], signatures: [], level: 'low' }

  for (const [pattern, weight, family] of DETECTOR_RULES) {
    const match = pattern.exec(text)
    if (match === null) continue
    signal.score = Math.max(signal.score, weight)
    signal.families.push(family)
    signal.signatures.push((match[0] as string).slice(0, 40))
  }

  // 多重命中加成（多信号聚簇的最小形态）
  if (signal.families.length >= 2) {
    signal.score = Math.min(1, signal.score + 0.1)
  }

  // 分级（高危仅升级审计，不阻断——P3）
  if (signal.score >= highThreshold) signal.level = 'high'
  else if (signal.score >= warnThreshold) signal.level = 'warn'

  return signal
}

/**
 * 分级 → 可比较的序号（审计与断路器需要"取更严的一档"）。
 *
 * 封闭判别联合：新加分级而未处理时由 `assertNever` 在编译期与运行期同时响。
 */
export function riskLevelRank(level: RiskLevel): number {
  switch (level) {
    case 'low':
      return 0
    case 'warn':
      return 1
    case 'high':
      return 2
    default:
      return assertNever(level, 'detect-level')
  }
}
