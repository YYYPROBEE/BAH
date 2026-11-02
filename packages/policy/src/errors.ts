/**
 * 策略编译器的稳定错误码与定位格式（设计方案 01 §6.4）。
 *
 * 两条纪律：
 * 1. **错误码是契约**：`code` 只增不改名，门禁与外部工具按它分支；
 * 2. **定位必须能点到行**：任何与源文件有关的错误都带 `file:line`，与某一行规则有关的
 *    错误再带 `ruleId`。CLI 首行输出 `file:line: ruleId: message`，不打堆栈。
 *
 * 码表比方案 §6.4 的 24 条多 4 条（含 S5 的 `policy-regex-unsafe`）：§2.2 的 `policy-input-invalid`、§5.4 的
 * `policy-eval-overflow`，以及"IR 被篡改"的 `policy-eval-invalid`（§4.2 不变式 3 要求
 * 运行期只可能因 IR 损坏失败，必须给它一个可判别的码，否则治理平面只能当未知异常）。
 */

import { BahError } from '@bah/util'

/** 编译器与求值器的全部稳定错误码（顺序即文档顺序，测试按此表逐条取证）。 */
export const POLICY_ERROR_CODES = [
  // 编译期：YAML / manifest / 表达式 / 表 / 文件
  'policy-parse-error',
  'policy-schema-invalid',
  'policy-unknown-key',
  'policy-unknown-field',
  'policy-unknown-operator',
  'policy-type-mismatch',
  'policy-unknown-param',
  'policy-param-unused',
  'policy-unknown-tool',
  'policy-duplicate-rule',
  'policy-missing-default',
  'policy-unreachable-row',
  'policy-unsatisfiable-row',
  'policy-lower-tier',
  'policy-bad-reason',
  'policy-bad-deny-code',
  'policy-row-action-conflict',
  'policy-deny-order',
  'policy-bad-semver',
  'policy-version-mismatch',
  'policy-digest-mismatch',
  'policy-signature-invalid',
  'policy-corpus-missing',
  'policy-limit-exceeded',
  'policy-engine-incompatible',
  // sentry 规则集：正则安全子集（S5）
  'policy-regex-unsafe',
  // 运行期：输入非法 / 求值异常（fail-closed，绝不变成 allow）
  'policy-input-invalid',
  'policy-eval-overflow',
  'policy-eval-invalid',
] as const

/** 错误码联合类型。 */
export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number]

/**
 * 结构化定位信息。
 *
 * 全部字段可选：错误码决定哪些字段必然出现（例如 `policy-unreachable-row` 必带
 * `file/line/by`，`policy-version-mismatch` 必带 `dir/declared`）。这样做而不是为每个码
 * 定义一个类型，是因为调用方（CLI / 门禁 / 治理平面）只需要读，不需要穷举形状。
 */
export interface PolicyErrorDetail {
  /** bundle 内相对路径（如 `rules.yml`）或绝对路径。 */
  readonly file?: string
  /** 1 基行号。 */
  readonly line?: number
  /** 1 基列号（单行 plain 标量上精确；多行标量给起始列）。 */
  readonly column?: number
  /** 规则 ID（行级错误必带）。 */
  readonly ruleId?: string
  /** 表 ID。 */
  readonly table?: string
  /** 表达式里的字段路径。 */
  readonly path?: string
  /** 期望值/类型。 */
  readonly expected?: string | number
  /** 实际值/类型。 */
  readonly actual?: string | number
  /** 名字（参数名/工具名/键名）。 */
  readonly name?: string
  /** 重复的 ID。 */
  readonly id?: string
  /** 首次出现的行号。 */
  readonly firstLine?: number
  /** 造成不可达的前序规则 ID。 */
  readonly by?: string
  /** 理由词。 */
  readonly reason?: string
  /** 拒绝码。 */
  readonly code?: string
  /** 版本。 */
  readonly version?: string
  /** 目录名。 */
  readonly dir?: string
  /** manifest 声明的版本。 */
  readonly declared?: string
  /** 上限名（尺寸/行数/深度）。 */
  readonly limit?: string
  /** 实际上限值。 */
  readonly max?: number
  /** 实际值。 */
  readonly size?: number
  /** 引擎版本范围。 */
  readonly engine?: string
  /** YAML 键。 */
  readonly key?: string
  /** manifest 字段。 */
  readonly field?: string
  /** 签名密钥版本。 */
  readonly keyVersion?: number
  /** 语料用例 ID。 */
  readonly caseId?: string
}

/**
 * 构造一条策略错误。
 *
 * @param code 稳定错误码
 * @param message 人读说明（不含定位前缀，由本函数拼）
 * @param detail 结构化上下文（同时作为 `BahError.detail`）
 */
export function policyError(
  code: PolicyErrorCode,
  message: string,
  detail: PolicyErrorDetail = {},
): BahError {
  return new BahError(code, `${where(detail)}${message}`, detail)
}

/** `file:line: ruleId: ` 前缀；缺哪个就不打哪个。 */
function where(detail: PolicyErrorDetail): string {
  const parts: string[] = []
  if (detail.file !== undefined) {
    parts.push(detail.line === undefined ? detail.file : `${detail.file}:${detail.line}`)
  }
  if (detail.ruleId !== undefined) parts.push(detail.ruleId)
  return parts.length === 0 ? '' : `${parts.join(': ')}: `
}

/** 把抛出物收敛成 `{ code, message }`（CLI 与门禁用；不吞信息）。 */
export function describePolicyError(error: unknown): { code: string; message: string } {
  if (error instanceof BahError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'policy-unknown-error', message: error.message }
  return { code: 'policy-unknown-error', message: String(error) }
}
