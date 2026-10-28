/**
 * `pnpm policy:keygen [--dir <path>] [--version <n>]`：生成策略签名密钥对（Ed25519）。
 *
 * 三条纪律（D6）：
 * 1. 私钥**不进仓**：默认目录在 `$BAH_POLICY_KEY_DIR` 或 `~/.bah/keys`；
 *    指向仓库内直接拒绝（除非显式 `--allow-repo`，只给演练用）；
 * 2. 版本号就是 `keyVersion`：轮换 = 生成新版本 → 重签全部 bundle → 生产配置
 *    `signature.allowedKeyVersions` 先 `[old, new]`，再收窄到 `[new]`（吊销旧钥）；
 * 3. 公钥文件名固定 `policy-ed25519-<version>.pub.pem`，私钥 `policy-ed25519-<version>.key`。
 */

import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const dirArg = flag('--dir')
const versionArg = flag('--version')
const allowRepo = argv.includes('--allow-repo')
const version = versionArg === undefined ? 1 : Number(versionArg)

if (!Number.isInteger(version) || version < 1) {
  console.error('✘ --version 必须是正整数')
  process.exitCode = 2
} else {
  const dir = resolve(dirArg ?? process.env['BAH_POLICY_KEY_DIR'] ?? join(homedir(), '.bah', 'keys'))
  const insideRepo = relative(repoRoot, dir)
  if (!allowRepo && insideRepo !== '' && !insideRepo.startsWith('..')) {
    console.error(
      `✘ 拒绝把私钥写进仓库（${dir}）；请用 --dir 指向仓外目录，或演练时显式 --allow-repo`,
    )
    process.exitCode = 2
  } else {
    const privatePath = join(dir, `policy-ed25519-${String(version)}.key`)
    const publicPath = join(dir, `policy-ed25519-${String(version)}.pub.pem`)
    if (existsSync(privatePath)) {
      console.error(`✘ 私钥已存在：${privatePath}（轮换请换 --version）`)
      process.exitCode = 1
    } else {
      mkdirSync(dir, { recursive: true })
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8')
      writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8')
      console.log(`✔ 已生成策略签名密钥（keyVersion=${String(version)}）`)
      console.log(`  私钥（不进仓）：${privatePath}`)
      console.log(`  公钥（分发）：  ${publicPath}`)
      console.log('  下一步：pnpm policy:sign <bundle-dir> --key ' + privatePath)
    }
  }
}

function flag(name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
