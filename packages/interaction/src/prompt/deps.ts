/**
 * `prompt_ask` 的依赖面（03 单 §3.11）。
 *
 * 追问台账由宿主插件维护：`ToolExecContext` 是最小冻结面，不扩它。
 */

/** 会话级追问计数（同槽位累计，防死循环）。换槽位重新计数。 */
export interface PromptAskLedger {
  count(sessionId: string, slot: string): number
  increment(sessionId: string, slot: string): void
}

export interface PromptAskDeps {
  readonly ledger: PromptAskLedger
}
