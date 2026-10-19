/**
 * 工具名通配匹配（施工单 10 §3 的内核组件 8：`wildcardToRegExp`）。
 * 对应源文件 `sentry-dsh-plugin/src/kernel/wildcard.js`——模式语义逐字对应。
 *
 * 与 Harness 内置 `repeat-tool-reminder` 保持同一语义：`*` 通配，其余元字符按字面量，
 * 整串锚定、大小写敏感（工具名本来就是精确标识符）。
 */

/** 需要转义的正则元字符（`*` 单独处理，不在这里）。 */
const REGEXP_METACHARACTERS = /[|\\{}()[\]^$+?.]/g

/**
 * 编译一个 `*` 通配模式为锚定正则。
 *
 * @param pattern - 形如 `transfer*`、`mcp_*` 的模式。
 * @returns 锚定正则（大小写敏感，与工具名精确语义一致）。
 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(REGEXP_METACHARACTERS, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}
