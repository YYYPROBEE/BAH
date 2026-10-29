/**
 * 子命令路由（施工单 16 §2.1）。
 *
 * 只有 argv 首项精确命中子命令名才进入子命令模式；其余原样交给现有 flag 解析器。
 * 现有 `parseArgs` 的语义一行不改——这是本模块存在的唯一理由。
 */

/** `bah` 的一次调用形态。 */
export type Command =
  | { readonly kind: 'run' }
  | { readonly kind: 'audit' }
  | { readonly kind: 'sentry' }
  | { readonly kind: 'halt' }
  | { readonly kind: 'unfreeze' }
  | { readonly kind: 'metrics' }
  | { readonly kind: 'trace' }
  | { readonly kind: 'cost' }

/** 首项是子命令 → 子命令模式；否则 → 现有 flag 模式。 */
export function parseCommand(argv: readonly string[]): Command {
  switch (argv[0]) {
    case 'audit':
      return { kind: 'audit' }
    case 'sentry':
      return { kind: 'sentry' }
    case 'halt':
      return { kind: 'halt' }
    case 'unfreeze':
      return { kind: 'unfreeze' }
    case 'metrics':
      return { kind: 'metrics' }
    case 'trace':
      return { kind: 'trace' }
    case 'cost':
      return { kind: 'cost' }
    default:
      return { kind: 'run' }
  }
}
