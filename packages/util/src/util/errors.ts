/**
 * @bah/util · 统一错误形态与穷尽性收尾（施工单 00 §9）。
 *
 * 独立成文件是为了让 `canonical.ts` 等原语可以引用 `BahError`，
 * 而不必反向 import 包入口（会形成 ESM 循环）。
 */

/**
 * 全仓统一的结构化错误形态。
 *
 * 纪律（施工单 00 §9 第 5 条）：错误必须结构化——类型化失败 + 可读理由码，
 * 禁止静默吞错。`code` 一律 kebab-case（如 `no-identity`、`ticket-expired`）。
 */
export class BahError extends Error {
  /** 可读理由码（kebab-case），用于门禁、审计与前端分支。 */
  readonly code: string
  /** 结构化上下文（插件名、路径、阈值等），不参与面向用户的文案。 */
  readonly detail?: unknown

  constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'BahError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 封闭联合的穷尽性收尾（施工单 00 §9 第 6 条：判别标签 switch 以 assertNever 收尾）。
 *
 * 走到这里说明新增了一个未处理的判别标签——必须是运行期失败，不能静默返回。
 */
export function assertNever(value: never, context = 'unreachable'): never {
  throw new BahError('unreachable-branch', `${context}: ${String(value)}`, { context })
}

/**
 * 任意抛出物 → 结构化理由码（**全仓唯一实现**，门禁 `verify-single-error-normalization`）。
 *
 * @param error 抛出物（`unknown`：JS 允许抛任何东西）
 * @param fallback 兜底码。**必须显式传**：`tool-failed` 与 `verify-failed` 的差异是有意的，
 *   调用方按 code 分支决定是否重试；给兜底码一个默认值会把这种可判别性悄悄抹平
 *   （技术债复审 2026-10-20 风险提示 3，该件已撤下）。
 */
export function errorCodeOf(error: unknown, fallback: string): string {
  if (error instanceof BahError) return error.code
  // 跨包/跨进程的错误（例如 provider 抛的）未必是本仓的 BahError，按形状取码
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return fallback
}

/**
 * 任意抛出物 → 可读理由（非 `Error` 也留文本，禁止静默吞错）。
 *
 * 与 `errorCodeOf` 的分工：code 给机器分支，reason 给人看；两者都不许丢信息。
 */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  return String(error)
}
