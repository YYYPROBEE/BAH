/**
 * 生成口令哈希（租户与鉴权 02 · TA-22 的配套）。
 *
 * ## 为什么默认从 stdin 读
 *
 * `npx tsx scripts/auth-hash.ts demo1234` 会把口令写进 shell 历史（`~/.bash_history` /
 * PowerShell 的 PSReadLine 文件），而且一个带口令的进程会出现在进程列表里。
 * 所以**默认 `--stdin`**，argv 形式只保留给自动化，并打一条警告。
 *
 * ```bash
 * npx tsx scripts/auth-hash.ts --stdin <<< "demo1234"
 * echo -n "demo1234" | npx tsx scripts/auth-hash.ts --stdin
 * ```
 *
 * 输出只有一行 `scrypt$…`：可以整行粘进 `auth/users.yml` 的 `password`。
 */

import { hashPassword } from '../packages/host/src/boot/plugins/web/auth/password.ts'

/** 从 argv 读（会打警告）。 */
function fromArgv(): string | undefined {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  const first = args[0]
  return first === undefined || first === '' ? undefined : first
}

/** 从 stdin 读（读到 EOF）。 */
async function fromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** 脚本入口。 */
async function main(): Promise<number> {
  const useStdin = process.argv.includes('--stdin')
  const plain = useStdin ? await fromStdin() : fromArgv()
  if (plain === undefined || plain === '') {
    console.error('用法：npx tsx scripts/auth-hash.ts --stdin <<< "<口令>"（推荐）')
    console.error('      npx tsx scripts/auth-hash.ts <口令>     （会进 shell 历史，不推荐）')
    return 2
  }
  // 去尾换行（`<<<` 会带一个）；口令本身不 trim 中间的空白
  const normalized = plain.replace(/\r?\n$/, '')
  if (!useStdin) {
    console.warn('[auth-hash] 口令出现在 argv 里会进 shell 历史与进程列表；下次请用 --stdin')
  }
  console.log(await hashPassword(normalized))
  return 0
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.includes('auth-hash')) {
  process.exitCode = await main()
}
