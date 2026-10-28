/**
 * 引擎版本与硬上限（施工方案 01 §5.3 / §7.2 / 03 §2.3）。
 *
 * 这些数字是**安全边界**，不是可调参数：调大它们等于放宽"坏规则进不来"的口径，
 * 必须走方案 §14 的变更登记，不在代码里留"改个常量就行"的入口。
 */

/** DSL 能力版本（不是包版本）。bundle 的 `engine.min/max` 与它比对。 */
export const POLICY_ENGINE_VERSION = '1.0.0'

/** 编译器硬上限。 */
export const POLICY_LIMITS = {
  /** 单个 bundle 的源文件总字节（不含 lock.json / bundle.sig）。 */
  maxBundleBytes: 262_144,
  /** 单条表达式的字符数。 */
  maxExprChars: 4_096,
  /** 单个字符串字面量的字符数（防注释注入型超长串；规则里的字符串是枚举值，1024 足够）。 */
  maxStringLength: 1_024,
  /** 表达式 AST 深度（括号/运算/一元）。 */
  maxExprDepth: 32,
  /** bundle 内表数。 */
  maxTables: 32,
  /** 单表行数。 */
  maxRowsPerTable: 128,
  /** manifest `description` 上限（下限在校验里写死 8）。 */
  maxDescription: 200,
} as const
