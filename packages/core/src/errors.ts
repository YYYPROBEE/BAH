/**
 * 内核错误形态（施工单 00 §10、02 §0 第 4 条）。
 *
 * 全仓错误形态统一为 `@bah/util` 的 `BahError`（`code` + `detail`）；内核只负责两件事：
 * 给 message 补 `bah-core: ` 前缀，并把任意抛出物归一成可读理由（禁止静默吞错）。
 * 理由码一律 kebab-case，调用方按 `code` 分支，**不许解析 message 文本**。
 */

import { BahError } from '@bah/util'

/** 内核错误统一前缀：出口标准第 4 条要求所有 fail-loud 错误都带它。 */
export const CORE_PREFIX = 'bah-core: '

/**
 * 构造内核错误。
 *
 * @param code 可读理由码（kebab-case），如 `inject-deadlock`、`invalid-config`
 * @param message 面向开发者的理由（不带前缀；内核错误一律由本函数补前缀）
 * @param detail 结构化上下文（插件名 / 服务键 / 事件名），不参与面向用户的文案
 */
export function coreError(code: string, message: string, detail?: unknown): BahError {
  return new BahError(code, `${CORE_PREFIX}${message}`, detail)
}

/**
 * 把任意抛出物归一成可读理由。
 *
 * `throw 'x'` 这种非 Error 抛出物也必须留下文本——否则日志里只剩 `undefined`，
 * 等于静默吞错（施工单 00 §9 第 5 条）。
 */
export function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown)
}
