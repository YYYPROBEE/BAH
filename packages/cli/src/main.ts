/**
 * `@bah/cli` 可执行入口（根 `package.json` 的 `bah` 脚本指向本文件）。
 *
 * 只做两件事：解析 argv、把退出码交给进程。真正的工作在 `cli/run.ts`。
 *
 * 运行方式：`pnpm bah --profile headless --dump-config`。
 * 源码解析走根 `tsconfig.json` 的 `paths`（`@bah/<pkg>` → `packages/<pkg>/src/index.ts`），
 * 因此**不需要先 build**——CLI 永远跑当前源码，不会悄悄跑旧产物。
 */

import { runCli } from './cli/index.ts'

process.exitCode = await runCli(process.argv.slice(2), {
  out: (message) => {
    console.log(message)
  },
  err: (message) => {
    console.error(message)
  },
})
