/**
 * @bah/util · util —— 零依赖基础原语（施工单 00 §9 / §10）。
 *
 * 本文件只放"全仓所有包都要依赖、且没有任何领域语义"的东西：
 * 阶段 1 只有统一错误形态与穷尽性收尾两个原语。
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
