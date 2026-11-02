/**
 * 起桌面端演示：`pnpm demo:desktop`。
 *
 * 只做三件事，全部是启动环境的准备，不碰装配：
 * 1. 读仓库根的 `.env.local`（`.gitignore` 的 `.env*` 挡住，不会入库）；
 * 2. 清掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`——从 IDE / agent shell 继承来的这两个
 *    变量会让 `electron.exe` 退化成纯 Node（`require('electron')` 变成 exe 路径字符串）；
 * 3. 用干净的 env 起 Electron，stdout / stderr 重定向到 `.tmp-desktop-*.log`。
 *
 * 为什么不让主进程自己读 `.env.local`：桌面端是双击即用的壳，不是配置器；密钥属于
 * 启动环境（用户的 shell / 部署平台 / 本脚本），写进应用会让「哪份密钥生效」不可解释。
 *
 * 密钥缺失不挡启动（`core:model=deepseek` 只在第一次调模型时报「未配置密钥」），
 * 所以这里只警告、不退出——窗口能开、能看到错误，比静默退化成空窗口好排查。
 */

import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(root, '.env.local')

/** 宽松解析 `.env.local`（只认 `KEY=VALUE`；空行与 `#` 注释跳过）。 */
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

const env = { ...readEnvFile(envFile), ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

if (env.BAH_MODEL_KEY === undefined || env.BAH_MODEL_KEY === '') {
  console.warn(
    '[demo:desktop] 未设置 BAH_MODEL_KEY：desktop profile 走 deepseek，第一轮对话会报「未配置密钥」。' +
      '请在仓库根 .env.local 写入 BAH_MODEL_KEY 后重试。',
  )
}

const appDir = join(root, 'apps', 'desktop')
// pnpm 是隔离依赖：根目录解析不到 electron，必须从桌面包自己的 node_modules 解析。
const electronPath = createRequire(join(appDir, 'package.json'))('electron')
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
const out = openSync(join(root, `.tmp-desktop-${stamp}.log`), 'w')
const err = openSync(join(root, `.tmp-desktop-${stamp}.log.err`), 'w')

const child = spawn(electronPath, [appDir], {
  cwd: appDir,
  env,
  stdio: ['ignore', out, err],
})

console.log(`[demo:desktop] 已启动 Electron（PID ${String(child.pid)}）`)
console.log(`[demo:desktop] 日志：.tmp-desktop-${stamp}.log / .log.err`)

child.on('error', (error) => {
  console.error(`[demo:desktop] 无法启动 —— ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code) => {
  process.exitCode = code ?? 0
})
