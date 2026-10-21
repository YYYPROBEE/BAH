/**
 * `bah audit` 子命令（施工单 16）。
 *
 * 步骤 1 只提供占位与帮助常量；真正的审计逻辑在步骤 2/3 接入。
 */

import type { CliIo, CliOptions } from './run.ts'

export const AUDIT_USAGE =
  '用法：bah audit --dir <path> [--saga <id>] [选项]（-h 看完整帮助）'

export const AUDIT_HELP = [
  'bah audit —— 对落盘目录做一次只读证据链核验（施工单 16）',
  '',
  AUDIT_USAGE,
  '',
  '选项：',
  '  --dir <path>        待审计目录（缺省 sessions/）',
  '  --saga <id>         只审一条链（缺省全部）',
  '  --db <path>         saga 库（缺省 <dir>/saga.sqlite）',
  '  --no-projection     跳过投影重算',
  '  --key <path>        验签私钥（缺省 keys/saga-ed25519.pem）',
  '  --format <fmt>      text | json（缺省 text）',
  '  --no-signature      跳过验签（只验链连续性）',
  '  -h, --help          显示本帮助',
].join('\n')

export async function runAudit(
  _argv: readonly string[],
  io: CliIo,
  _options: CliOptions = {},
): Promise<number> {
  io.err('bah audit: 尚未实现（施工步骤 1 占位）')
  io.err(AUDIT_USAGE)
  return 2
}
