/**
 * 起 Web 演示：`pnpm demo:web`。
 *
 * 与 `pnpm web` 的唯一区别：先读仓库根的 `.env.local`，把密钥灌进子进程环境。
 *
 * 为什么不在 profile 里写密钥、也不提供 `--key` 参数：
 * profile 进版本库，`--key` 进进程列表与 shell history。`.env.local` 被
 * `.gitignore` 的 `.env*` 挡住，是这三条路里唯一不会泄漏的。
 *
 * `.env.local` 形如（键值不带引号，`#` 开头为注释）：
 *
 * ```text
 * BAH_MODEL_KEY=<your-key>
 * ```
 *
 * 没有这个文件也能起：进程照常启动，第一次调模型时由适配器报"未配置密钥"。
 * 演示前请确认 `profiles/web/patch.yml` 的 `core:model.apiKeyEnv` 与这里同名。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(root, '.env.local')

/** 读 `.env.local`（宽松解析：只认 `KEY=VALUE`，空行与 `#` 注释跳过）。 */
function readEnvFile(path) {
  const values = {}
  if (!existsSync(path)) return values
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key !== '' && value !== '') values[key] = value
  }
  return values
}

const fromFile = readEnvFile(envFile)
// 已存在的环境变量优先：CI / 临时覆盖不该被本地文件顶掉
const env = { ...fromFile, ...process.env }

const keyName = 'BAH_MODEL_KEY'
if (env[keyName] === undefined || env[keyName] === '') {
  console.warn(
    `[demo:web] 没有找到 ${keyName}（读的是 ${envFile}）。` +
      '演示仍然能起来，但第一次调模型会报"未配置密钥"；' +
      '断网演示请把 profiles/web/patch.yml 的 provider 换成 router。',
  )
}

const child = spawn(
  process.execPath,
  [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'packages/cli/src/main.ts', '--profile', 'web', '--serve'],
  { cwd: root, stdio: 'inherit', env },
)

child.on('error', (error) => {
  console.error(`[demo:web] 无法启动 —— ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[demo:web] 被信号中断（${signal}）`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
