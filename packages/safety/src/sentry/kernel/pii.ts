/**
 * 代币化编译器（PII Vault， 的内核组件 4：`pii`）。
 * 由本工程安全内核的 `kernel/pii` 迁移而来——模式表、代币格式、掩码口径与
 * 目的地白名单全部保持一致。
 *
 * PII/机密 → 代币；持有映射的一侧才可还原。已将原项目的两处实测修复内化为本实现：
 *  - A1：全量替换（`replaceAll`）而非单次替换——重复出现的 PII 不会残留原文；
 *  - B2：正则快速预检——零命中直接返回，不做无谓编译。
 * 目的地白名单的选择性还原（`detokenize`）保留为库能力（见 README「提炼边界」）。
 *
 * 内核零依赖纪律下的唯一替换：随机段不再取 `node:crypto`，改为构造时注入的
 * `randomHex`（缺省用 `globalThis.crypto`），这样"确定性代币串"在单测里可直接钉住。
 */

/** PII / 机密类型标签（封闭集合，与模式表一一对应）。 */
export type PiiType = 'PHONE' | 'IDCARD' | 'BANKCARD' | 'EMAIL' | 'SECRET_KEY'

/** 模式表条目：`[类型, 全局正则]`。 */
export type PiiPattern = readonly [type: PiiType, pattern: RegExp]

/**
 * PII / 机密模式表。
 */
const PII_PATTERNS: readonly PiiPattern[] = [
  ['PHONE', /1[3-9]\d{9}/g],
  ['IDCARD', /\d{17}[\dXx]/g],
  ['BANKCARD', /\b\d{16,19}\b/g],
  ['EMAIL', /[\w.+-]+@[\w-]+\.[\w.]+/g],
  ['SECRET_KEY', /(sk|api|token|key|密码|口令)[-_=:：\s]*[A-Za-z0-9_\-]{16,}/gi],
]

/**
 * 目的地白名单：哪些"动作参数槽"允许解代币（显式枚举，deny-by-default）。
 * 例：给最终用户发邮件 / 返回给用户的响应正文可还原 PII。
 */
export const DETOKEN_DESTINATIONS: Readonly<Record<string, readonly string[]>> = {
  send_email: ['to', 'body'],
  response_body: ['text'],
}

/** Vault 映射表的一条记录。 */
export interface TokenMapping {
  readonly original: string
  readonly type: PiiType
  readonly source: string
}

/** `compile()` 回报的一条替换（代币本身 + 归类信息；**不含原文**）。 */
export interface TokenReplacement {
  readonly token: string
  readonly type: PiiType
  readonly source: string
}

/** `detect()` 的一条命中（掩码形态，可直接进审计）。 */
export interface PiiDetection {
  readonly type: PiiType
  readonly masked: string
}

/** `compile()` 的返回：`[代币化文本, 替换清单]`。 */
export type CompileResult = readonly [text: string, replaced: TokenReplacement[]]

/** `TokenizerVault` 的装配参数。 */
export interface TokenizerVaultOptions {
  /** 代币随机段生成器（缺省 4 字节 hex；单测注入定值可得到完全确定的代币串）。 */
  readonly randomHex?: () => string
}

/**
 * 审计用掩码：保留前 4 位。
 *
 * @param value - 原文（任意可字符串化的值，与源面一致）。
 * @returns 掩码串。
 */
export function maskValue(value: unknown): string {
  return `${String(value).slice(0, 4)}***`
}

/**
 * 代币映射表（防护层持有；泄露信道拿到代币不可还原）。
 */
export class TokenizerVault {
  /** 代币 → 原文映射（防护层私有；只在本类内被读）。 */
  readonly map = new Map<string, TokenMapping>()

  private readonly randomHex: () => string

  constructor(options: TokenizerVaultOptions = {}) {
    this.randomHex = options.randomHex ?? defaultRandomHex
  }

  /**
   * 外部数据入上下文前的编译。
   *
   * @param text - 待编译文本。
   * @param source - 数据来源标签（如 `user_message` / `tool_result`），供审计归类。
   * @returns 代币化文本与替换清单。
   */
  compile(text: string, source: string): CompileResult {
    // B2：正则快速预检——零命中直接返回
    if (!PII_PATTERNS.some(([, pattern]) => text.match(pattern) !== null)) return [text, []]

    let out = text
    const replaced: TokenReplacement[] = []
    for (const [type, pattern] of PII_PATTERNS) {
      // A1：按"去重后的全体原文"做全量替换，杜绝重复 PII 残留
      const originals = [...new Set(matchAll(text, pattern).map((match) => match[0] ?? ''))]
      for (const original of originals) {
        const token = `⟦TK:${type}:${this.randomHex()}⟧`
        this.map.set(token, { original, type, source })
        out = out.replaceAll(original, token)
        replaced.push({ token, type, source })
      }
    }
    return [out, replaced]
  }

  /**
   * 仅检测（不替换）：返回审计友好的命中清单。
   *
   * @param text - 待检文本。
   * @returns 掩码化命中清单。
   */
  detect(text: string): PiiDetection[] {
    const hits: PiiDetection[] = []
    for (const [type, pattern] of PII_PATTERNS) {
      for (const match of matchAll(text, pattern)) hits.push({ type, masked: maskValue(match[0] ?? '') })
    }
    return hits
  }

  /**
   * 目的地白名单校验 + 选择性还原（确定性）。
   *
   * @param toolName - 目标工具名。
   * @param argName - 参数槽名。
   * @param value - 参数值。
   * @returns 白名单内还原后的值；否则原样返回（代币保持不可还原）。
   */
  detokenize(toolName: string, argName: string, value: string): string {
    const allowed = DETOKEN_DESTINATIONS[toolName] ?? []
    if (!allowed.includes(argName)) return value
    let out = value
    for (const [token, { original }] of this.map) {
      if (out.includes(token)) out = out.replaceAll(token, original)
    }
    return out
  }

  /**
   * 出站扫描：检查文本中是否残留"未授权还原的原文"。
   *
   * @param value - 出站文本（响应/参数）。
   * @returns 掩码化的泄露样本清单。
   */
  leakReport(value: string): string[] {
    const leaks: string[] = []
    for (const { original } of this.map.values()) {
      if (original !== '' && value.includes(original)) leaks.push(maskValue(original))
    }
    return leaks
  }
}

/** `String.prototype.matchAll` 的数组封装（正则常量带 /g，matchAll 内部克隆、不改 lastIndex）。 */
function matchAll(text: string, pattern: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(pattern)]
}

/** 默认随机段：4 字节 hex（与源的 `randomBytes(4).toString('hex')` 同宽度）。 */
function defaultRandomHex(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
