/**
 * 危险参数规则库（施工单 10 §3 的内核组件 3：`rules`——工具面的确定性硬拦截面）。
 * 对应源文件 `sentry-dsh-plugin/src/kernel/rules.js`——13 条内置规则的正则、族标签与
 * 规则级白名单校准位全部照搬（IN6 全量对齐）。
 *
 * 工具参数槽的确定性危险模式检测：以规则值为准的硬拦截面（零概率误报——
 * 命中与否由正则决定，不由模型打分决定）。规则库级白名单校准位保留
 * （演示环境放行示例外发，对应原 `_RULE_WHITELIST`）。
 */

import { BahError } from '@bah/util'

/** 内置规则覆盖的六个危险族。 */
export type RuleFamily = 'destructive' | 'privilege' | 'supply' | 'code' | 'exfil' | 'privacy'

/** 内置规则形状（族与说明都是必填——库里不许留空位）。 */
export interface BuiltinRule {
  readonly id: string
  readonly pattern: RegExp
  readonly family: RuleFamily
  readonly note: string
}

/** 部署侧追加的规则（族与说明可缺省，缺省回落 `unknown` / 空串，与源一致）。 */
export interface ExtraRule {
  readonly id: string
  readonly pattern: RegExp
  readonly family?: string
  readonly note?: string
}

/** 扫描面的统一规则视角。 */
export type ScanRule = BuiltinRule | ExtraRule

/** `scanToolArgs()` 的选项（全部来自校验过的 Config 字段，插件不硬编码可调项）。 */
export interface ScanToolArgsOptions {
  /** 停用的内置规则 ID。 */
  readonly disabledIds?: readonly string[]
  /** 是否启用 NET-001 演示校准（缺省 = 开，与源一致）。 */
  readonly demoWhitelist?: boolean
  /**
   * 基础规则集（策略外置 S5）：bundle 模式注入编译出的 13 条规则；
   * 缺省 = 内核内置的 `BUILTIN_RULES`（legacy 模式零变化）。
   */
  readonly baseRules?: readonly ScanRule[]
  /** 追加规则。 */
  readonly extraRules?: readonly ExtraRule[]
}

/** 一条命中（空数组 = 参数槽干净）。 */
export interface RuleFinding {
  readonly id: string
  readonly family: string
  readonly hit: string
  readonly note: string
}

/**
 * 内置规则（IN6 全量 13 条）。
 */
export const BUILTIN_RULES: readonly BuiltinRule[] = [
  { id: 'CMD-001', pattern: /\brm\s+(-[rfRF]{1,2}\s*)+(\S+)/i, family: 'destructive', note: '递归强删文件系统命令' },
  { id: 'CMD-002', pattern: /\b(sudo|su\s+root)\b/i, family: 'privilege', note: '提权命令' },
  { id: 'CMD-003', pattern: /\bchmod\s+[0-7]{3,4}\s+(\/|\*|~)/i, family: 'destructive', note: '对根/通配符改权' },
  { id: 'CMD-004', pattern: /\bformat\b\s+[a-zA-Z]:/i, family: 'destructive', note: '格式化磁盘' },
  { id: 'CMD-005', pattern: /\b(shutdown|reboot|halt|init\s+0|init\s+6)\b/i, family: 'destructive', note: '主机关停命令' },
  { id: 'CMD-006', pattern: />\s*\/dev\/sd[a-z]/i, family: 'destructive', note: '直写块设备' },
  { id: 'CMD-007', pattern: /\bcurl\b[^|]*\|\s*(ba)?sh/i, family: 'supply', note: '网络脚本管道执行（curl|sh）' },
  { id: 'CMD-008', pattern: /\b(eval|exec)\s*\(\s*(input|request|user)/i, family: 'code', note: '动态执行用户输入' },
  { id: 'NET-001',
    pattern: /https?:\/\/(?!api\.trusted\.internal)(?!\w+\.gov\.cn)[\w.-]+\/(upload|post|webhook|report)/i,
    family: 'exfil', note: '向非白名单外部地址上传/上报' },
  { id: 'NET-002',
    pattern: /\b(exfil|外发|上传到|发送到)(云|网盘|pastebin|telegram|webhook)/i,
    family: 'exfil', note: '显式外发指示' },
  { id: 'SQL-001',
    pattern: /(DROP\s+TABLE|DELETE\s+FROM\s+\w+\s*(?!WHERE)|;--|UNION\s+SELECT\s+password)/i,
    family: 'destructive', note: '破坏性/拖库 SQL' },
  { id: 'PRV-001',
    pattern: /(系统提示词|system\s*prompt|初始指令).{0,24}(打印|输出|复述|告诉我|发送)/i,
    family: 'privacy', note: '系统提示套取' },
  { id: 'PRV-002',
    pattern: /(全部|所有)(用户|客户|员工)(数据|信息|记录).{0,16}(导出|下载|列出|打包)/i,
    family: 'privacy', note: '批量敏感数据导出' },
]

/** 规则库级白名单校准（防误报的规则级修正位）。 */
const RULE_WHITELIST: Readonly<Record<string, RegExp>> = {
  'NET-001': /\b(demo|example|mock)\b/i,
}

/**
 * 把工具参数规约为确定性文本 blob（顶层值拼接，对应原实现 `" ".join(str(v) ...)`）。
 *
 * @param args - 工具调用的 `arguments`（已解析 JSON，或畸形 JSON 的原始字符串回退）。
 * @returns 用于规则匹配的文本。
 */
export function collectBlob(args: unknown): string {
  if (typeof args === 'string') return args
  if (args === null || args === undefined) return ''
  if (typeof args !== 'object') return String(args)
  const values = Array.isArray(args) ? args : Object.values(args)
  return values
    .filter((value) => value !== null && value !== undefined)
    .map(stringifyValue)
    .join(' ')
}

/**
 * 扫描工具参数槽。确定性，零概率误报。
 *
 * @param args - 工具参数。
 * @param options - 停用位 / 演示校准 / 追加规则。
 * @returns 命中清单（空数组 = 干净）。
 */
export function scanToolArgs(args: unknown, options: ScanToolArgsOptions = {}): RuleFinding[] {
  const disabled = new Set(options.disabledIds ?? [])
  const whitelistEnabled = options.demoWhitelist !== false
  const rules: readonly ScanRule[] = [...(options.baseRules ?? BUILTIN_RULES), ...(options.extraRules ?? [])]
  const blob = collectBlob(args)
  const findings: RuleFinding[] = []

  for (const rule of rules) {
    if (disabled.has(rule.id)) continue
    const match = rule.pattern.exec(blob)
    if (match === null) continue
    const calibration = RULE_WHITELIST[rule.id]
    if (whitelistEnabled && calibration !== undefined && calibration.test(blob)) continue
    findings.push({
      id: rule.id,
      family: rule.family ?? 'unknown',
      hit: (match[0] ?? '').slice(0, 60),
      note: rule.note ?? '',
    })
  }
  return findings
}

/** 单个值的确定性字符串化：字符串原样；其余 `JSON.stringify`（失败时 `String` 回退）。 */
function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    // JSON 表达不了的维度（BigInt / 自引用）退回字符串化——值不能悄悄丢掉，blob 是拦截面唯一的输入
    try {
      return String(value)
    } catch {
      throw sentryError('rules-blob-invalid', '工具参数既无法 JSON 序列化也无法字符串化', value)
    }
  }
}

/** 造一个带包前缀的结构化错误（纪律：错误必须结构化，禁止裸 `throw new Error`）。 */
function sentryError(code: string, message: string, detail?: unknown): BahError {
  return new BahError(code, `bah-sentry: ${message}`, detail)
}
